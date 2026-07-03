import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createColorSynonymSchema,
  parseOrThrow,
  updateColorSynonymSchema,
  type CreateColorSynonymInput,
  type UpdateColorSynonymInput,
} from '@/common/validation';
import { ColorSynonymsRepository } from './color-synonyms.repository';
import { ColorsService } from './colors.service';
import type { ColorSynonym } from './entities/color-synonym.entity';

/**
 * Color-synonym logic. Owns the dialect-term -> canonical-family resolution that
 * ProductsService uses to normalize customer color terms, and the admin CRUD for
 * the synonym table. Exported so the agent (via ProductsService) and the admin UI
 * share one normalization path.
 */
@Injectable()
export class ColorSynonymsService {
  constructor(
    private readonly repo: ColorSynonymsRepository,
    private readonly colorsService: ColorsService,
  ) {}

  list(opts?: ListOptions): Promise<ColorSynonym[]> {
    return this.repo.list(opts);
  }

  /** All dialect terms that resolve to a given color. */
  listByColor(colorId: string): Promise<ColorSynonym[]> {
    return this.repo.findByColorId(colorId);
  }

  async getById(id: string): Promise<ColorSynonym> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Color synonym ${id} not found`);
    }
    return row;
  }

  getByTerm(term: string): Promise<ColorSynonym | undefined> {
    return this.repo.findByTerm(term);
  }

  /** Resolve a dialect color term to its canonical family, or null if unknown. */
  resolveColorFamily(term: string): Promise<string | null> {
    return this.repo.resolveColorFamily(term);
  }

  /**
   * EVERY canonical family a customer color term can mean — canonical color
   * names and dialect synonyms, exact and fuzzy, Arabic-normalized (hamza
   * variants folded). Generic terms fan out: "اخضر" → [green, light_green].
   * This is the search-path resolver; a term matching no family returns [].
   */
  resolveColorFamilies(term: string): Promise<string[]> {
    return this.repo.resolveColorFamilies(term);
  }

  /**
   * Normalize a customer-supplied color term to a canonical family.
   * Resolution order:
   *   1. Exact match via color_synonyms.term (fast, indexed).
   *   2. Combined canonical-name + synonym resolution (Arabic-normalized,
   *      exact + fuzzy) via resolveColorFamilies — first family wins.
   *   3. Fuzzy trigram match via pg_trgm similarity (catches misspellings).
   *   4. Raw term fallback — returned as-is so the agent can still mention it.
   *
   * Single-family callers only (display/labels). SEARCH paths should use
   * resolveColorFamilies instead: collapsing "اخضر" to one of its two families
   * here would hide the other family's products.
   *
   * @param term  Any dialect color word the customer typed (e.g. "نبيتي").
   * @returns     Canonical color family (e.g. "red"), or the raw term if unknown.
   */
  async normalizeColor(term: string): Promise<string> {
    const exact = await this.repo.resolveColorFamily(term);
    if (exact) {
      return exact;
    }
    const [first] = await this.repo.resolveColorFamilies(term);
    if (first) {
      return first;
    }
    const fuzzy = await this.repo.resolveColorFamilyFuzzy(term);
    if (fuzzy) {
      return fuzzy;
    }
    return term;
  }

  async create(input: CreateColorSynonymInput): Promise<ColorSynonym> {
    const data = parseOrThrow(createColorSynonymSchema, input);
    // Verify the color exists so the caller gets a clean 404 instead of an
    // opaque FK violation when the synonym is inserted.
    await this.colorsService.getById(data.colorId);
    return this.repo.insert(data);
  }

  async update(
    id: string,
    patch: UpdateColorSynonymInput,
  ): Promise<ColorSynonym> {
    const data = parseOrThrow(updateColorSynonymSchema, patch);
    // Confirm the synonym exists first, so a missing synonym is reported as the
    // 404 rather than masking it behind a "color not found" from the check below.
    await this.getById(id);
    if (data.colorId !== undefined) {
      // Verify the replacement color exists before persisting.
      await this.colorsService.getById(data.colorId);
    }
    const row = await this.repo.updateById(id, data);
    if (!row) {
      throw new NotFoundException(`Color synonym ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<ColorSynonym> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Color synonym ${id} not found`);
    }
    return row;
  }
}
