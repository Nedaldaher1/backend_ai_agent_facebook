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
import type { ColorSynonym } from './entities/color-synonym.entity';

/**
 * Color-synonym logic. Owns the dialect-term -> canonical-family resolution that
 * ProductsService uses to normalize customer color terms, and the admin CRUD for
 * the synonym table. Exported so the agent (via ProductsService) and the admin UI
 * share one normalization path.
 */
@Injectable()
export class ColorSynonymsService {
  constructor(private readonly repo: ColorSynonymsRepository) {}

  list(opts?: ListOptions): Promise<ColorSynonym[]> {
    return this.repo.list(opts);
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

  create(input: CreateColorSynonymInput): Promise<ColorSynonym> {
    const data = parseOrThrow(createColorSynonymSchema, input);
    return this.repo.insert(data);
  }

  async update(
    id: string,
    patch: UpdateColorSynonymInput,
  ): Promise<ColorSynonym> {
    const data = parseOrThrow(updateColorSynonymSchema, patch);
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
