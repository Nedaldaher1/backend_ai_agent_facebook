import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import { colors } from './entities/color.entity';
import {
  colorSynonyms,
  type ColorSynonym,
  type NewColorSynonym,
} from './entities/color-synonym.entity';

/** Sentinel family excluded from every customer-facing resolution. */
const UNASSIGNED_FAMILY = '__unassigned__';

/**
 * Normalize Arabic for trigram matching: unify alef/hamza forms (أ إ آ → ا),
 * ta-marbuta → ha, alef-maqsura → ya. Customers type "اخضر" while the canonical
 * name is stored "أخضر" — raw trigrams score only 0.4 across that hamza
 * difference (below any usable threshold), so BOTH sides of every similarity
 * comparison go through this. SQL-side (not TS) so the same folding applies to
 * the stored column and the bound parameter.
 */
function arNorm(expr: unknown): ReturnType<typeof sql> {
  return sql`translate(${expr}, 'أإآةى', 'اااهي')`;
}

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

  /** All dialect terms that resolve to a given color, alphabetically by term. */
  async findByColorId(colorId: string): Promise<ColorSynonym[]> {
    return this.db
      .select()
      .from(colorSynonyms)
      .where(eq(colorSynonyms.colorId, colorId))
      .orderBy(asc(colorSynonyms.term));
  }

  /**
   * Resolve a dialect color term to its canonical family, or null if unknown.
   * Joins onto `colors` since the family now lives there (color_synonyms only
   * holds the FK).
   */
  async resolveColorFamily(term: string): Promise<string | null> {
    const [row] = await this.db
      .select({ family: colors.family })
      .from(colorSynonyms)
      .innerJoin(colors, eq(colors.id, colorSynonyms.colorId))
      .where(eq(colorSynonyms.term, term))
      .limit(1);
    return row?.family ?? null;
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
      .select({ family: colors.family })
      .from(colorSynonyms)
      .innerJoin(colors, eq(colors.id, colorSynonyms.colorId))
      .where(sql`similarity(${colorSynonyms.term}, ${term}) >= ${threshold}`)
      .orderBy(sql`similarity(${colorSynonyms.term}, ${term}) DESC`)
      .limit(1);
    return row?.family ?? null;
  }

  /**
   * ALL canonical families a customer color term can mean, in one query over
   * BOTH sources of truth — canonical `colors.name` and dialect
   * `color_synonyms.term` — with Arabic normalization (see arNorm) on every
   * comparison. A UNION of four signals, deduplicated:
   *
   *   1. exact (normalized) match on colors.name        — "ازرق غامق"
   *   2. exact (normalized) match on color_synonyms.term — "نبيتي"
   *   3. word_similarity(term, colors.name) >= nameThreshold — "بيج" inside
   *      "بيج فاتح", and crucially "اخضر" matches BOTH "أخضر" (green) and
   *      "أخضر فاتح" (light_green): a generic color word must return every
   *      family it covers, or variant-only products go missing from search.
   *   4. similarity(term, color_synonyms.term) >= synonymThreshold (misspellings)
   *
   * nameThreshold 0.55 is calibrated on the live catalog: real matches score
   * ≥ 0.6 ("زهري" ↔ "الزهري الفاتح") while the worst false positive — two
   * names sharing only a modifier word, "اخضر فاتح" ↔ "بيج فاتح" — scores 0.5.
   *
   * The sentinel family is never returned. Empty array = unknown term.
   */
  async resolveColorFamilies(
    term: string,
    { nameThreshold = 0.55, synonymThreshold = 0.3 } = {},
  ): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT family FROM (
        SELECT c.family
        FROM ${colors} AS c
        WHERE ${arNorm(sql`c.name`)} = ${arNorm(sql`${term}`)}
           OR word_similarity(${arNorm(sql`${term}`)}, ${arNorm(sql`c.name`)}) >= ${nameThreshold}
        UNION ALL
        SELECT c.family
        FROM ${colorSynonyms} AS s
        JOIN ${colors} AS c ON c.id = s.color_id
        WHERE ${arNorm(sql`s.term`)} = ${arNorm(sql`${term}`)}
           OR similarity(${arNorm(sql`s.term`)}, ${arNorm(sql`${term}`)}) >= ${synonymThreshold}
      ) AS matches
      WHERE family <> ${UNASSIGNED_FAMILY}
    `);
    const rows = (result.rows ?? []) as Array<{ family: string }>;
    return rows.map((r) => r.family);
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
