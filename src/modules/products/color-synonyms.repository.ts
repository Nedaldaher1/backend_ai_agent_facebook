import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  colorSynonyms,
  type ColorSynonym,
  type NewColorSynonym,
} from './entities/color-synonym.entity';

/**
 * Sole owner of color_synonyms SQL. The dialect-term -> canonical-family lookup
 * used by product search lives here (consolidated), so there is one source of
 * truth for color normalization. Query-builder only; no business logic.
 */
@Injectable()
export class ColorSynonymsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(opts: ListOptions = {}): Promise<ColorSynonym[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(colorSynonyms)
      .orderBy(direction(colorSynonyms.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findById(id: string): Promise<ColorSynonym | undefined> {
    const [row] = await this.db
      .select()
      .from(colorSynonyms)
      .where(eq(colorSynonyms.id, id))
      .limit(1);
    return row;
  }

  async findByTerm(term: string): Promise<ColorSynonym | undefined> {
    const [row] = await this.db
      .select()
      .from(colorSynonyms)
      .where(eq(colorSynonyms.term, term))
      .limit(1);
    return row;
  }

  /** Resolve a dialect color term to its canonical family, or null if unknown. */
  async resolveColorFamily(term: string): Promise<string | null> {
    const [row] = await this.db
      .select({ canonicalFamily: colorSynonyms.canonicalFamily })
      .from(colorSynonyms)
      .where(eq(colorSynonyms.term, term))
      .limit(1);
    return row?.canonicalFamily ?? null;
  }

  /**
   * Fuzzy-match a dialect color term using pg_trgm similarity.
   * Falls back gracefully to null when no synonym exceeds the threshold.
   * Requires the pg_trgm extension to be installed (already in place).
   *
   * @param term       The raw color term the customer typed (may be misspelled).
   * @param threshold  Minimum trigram similarity score (0–1); default 0.3.
   */
  async resolveColorFamilyFuzzy(
    term: string,
    threshold = 0.3,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ canonicalFamily: colorSynonyms.canonicalFamily })
      .from(colorSynonyms)
      .where(
        sql`similarity(${colorSynonyms.term}, ${term}) >= ${threshold}`,
      )
      .orderBy(
        sql`similarity(${colorSynonyms.term}, ${term}) DESC`,
      )
      .limit(1);
    return row?.canonicalFamily ?? null;
  }

  async insert(input: NewColorSynonym): Promise<ColorSynonym> {
    const [row] = await this.db.insert(colorSynonyms).values(input).returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewColorSynonym>,
  ): Promise<ColorSynonym | undefined> {
    const [row] = await this.db
      .update(colorSynonyms)
      .set(patch)
      .where(eq(colorSynonyms.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<ColorSynonym | undefined> {
    const [row] = await this.db
      .delete(colorSynonyms)
      .where(eq(colorSynonyms.id, id))
      .returning();
    return row;
  }
}
