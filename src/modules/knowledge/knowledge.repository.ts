import { Injectable } from '@nestjs/common';
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { TenantDb } from '@/core/tenancy/tenant-db';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  knowledgeEntries,
  type KnowledgeEntry,
  type NewKnowledgeEntry,
} from './entities/knowledge-entry.entity';
import { tokenizeSearchQuery } from '@/modules/products/search-tokenize.util';

/**
 * Filters for knowledge_entries. `isPublished` is explicit so the publish gate
 * is the caller's decision (service): the agent path forces `true`, admin omits
 * it. `search` matches title OR content; `tags` uses array overlap.
 * `productId` narrows to product-specific entries; omit for all entries.
 */
export interface KnowledgeFilter {
  category?: string;
  isPublished?: boolean;
  tags?: string[];
  search?: string;
  productId?: string;
}

/** Scope for relevance queries: either product-specific or global (productId IS NULL). */
export type KnowledgeScope =
  | { type: 'products'; productIds: string[] }
  | { type: 'global' };

/** Input for `findRelevant` — the service always forces isPublished:true on the agent path. */
export interface KnowledgeRelevanceFilter {
  scope: KnowledgeScope;
  isPublished?: boolean; // the service forces this true on every agent call
  category?: string;
  query?: string;
  limit?: number;
}

/**
 * Sole owner of knowledge_entries SQL. Query-builder only; the publish gate is a
 * filter the service sets, not a rule invented here. Ordered by priority then
 * recency so the agent retrieves the most relevant entries first.
 */
@Injectable()
export class KnowledgeRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  private buildConditions(filter: KnowledgeFilter): SQL[] {
    const conditions: SQL[] = [];

    if (filter.isPublished !== undefined) {
      conditions.push(eq(knowledgeEntries.isPublished, filter.isPublished));
    }
    if (filter.category) {
      conditions.push(eq(knowledgeEntries.category, filter.category));
    }
    if (filter.tags && filter.tags.length > 0) {
      conditions.push(arrayOverlaps(knowledgeEntries.tags, filter.tags));
    }
    if (filter.search) {
      const term = `%${filter.search}%`;
      const match = or(
        ilike(knowledgeEntries.title, term),
        ilike(knowledgeEntries.content, term),
      );
      if (match) {
        conditions.push(match);
      }
    }
    if (filter.productId) {
      conditions.push(eq(knowledgeEntries.productId, filter.productId));
    }

    return conditions;
  }

  async list(
    filter: KnowledgeFilter = {},
    opts: ListOptions = {},
  ): Promise<KnowledgeEntry[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const recency = orderBy === 'asc' ? asc : desc;
    const conditions = this.buildConditions(filter);

    return this.tenantDb.tx((db) =>
      db
        .select()
        .from(knowledgeEntries)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(
          desc(knowledgeEntries.priority),
          recency(knowledgeEntries.createdAt),
        )
        .limit(limit)
        .offset(offset),
    );
  }

  async count(filter: KnowledgeFilter = {}): Promise<number> {
    const conditions = this.buildConditions(filter);
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select({ value: count() })
        .from(knowledgeEntries)
        .where(conditions.length ? and(...conditions) : undefined);
      return row?.value ?? 0;
    });
  }

  async findById(id: string): Promise<KnowledgeEntry | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .limit(1);
      return row;
    });
  }

  async insert(input: NewKnowledgeEntry): Promise<KnowledgeEntry> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db.insert(knowledgeEntries).values(input).returning();
      return row;
    });
  }

  async updateById(
    id: string,
    patch: Partial<NewKnowledgeEntry>,
  ): Promise<KnowledgeEntry | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .update(knowledgeEntries)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(knowledgeEntries.id, id))
        .returning();
      return row;
    });
  }

  async deleteById(id: string): Promise<KnowledgeEntry | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .delete(knowledgeEntries)
        .where(eq(knowledgeEntries.id, id))
        .returning();
      return row;
    });
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<KnowledgeEntry | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .update(knowledgeEntries)
        .set({ isPublished, updatedAt: new Date() })
        .where(eq(knowledgeEntries.id, id))
        .returning();
      return row;
    });
  }

  /**
   * Retrieve knowledge entries relevant to a query/scope. Used by the agent path only.
   *
   * Scope:
   *  - `type==='products'`: filters to entries where productId IN productIds.
   *    Returns [] immediately when productIds is empty (no scope to search).
   *  - `type==='global'`: filters to entries where productId IS NULL.
   *
   * Fuzzy search (when query is set): Arabic-aware, per-TOKEN matching that mirrors
   * products.repository.searchFuzzy. Whole-string `similarity()` collapses for Arabic
   * sentences (the trigram overlap of a long query with a short entry is tiny), so we
   * match each meaningful token with `word_similarity(token, searchable)` — which finds
   * the token INSIDE the concatenated title+situation+content — OR an exact-substring
   * ILIKE the trigrams can miss. A coarse whole-query `similarity()` clause is kept as
   * an extra OR. All values are bound parameters — the query is NEVER concatenated into
   * the SQL string. `searchable` is `(coalesce(title,'') || ' ' || coalesce(situation,'')
   * || ' ' || coalesce(content,''))`.
   *
   * Ordering: query present → priority DESC + greatest(word_similarity, similarity) DESC;
   * else → priority DESC + createdAt DESC.
   */
  async findRelevant(
    filter: KnowledgeRelevanceFilter,
  ): Promise<KnowledgeEntry[]> {
    // Short-circuit: products scope with empty list can match nothing.
    if (
      filter.scope.type === 'products' &&
      filter.scope.productIds.length === 0
    ) {
      return [];
    }

    const conditions: SQL[] = [];

    if (filter.isPublished !== undefined) {
      conditions.push(eq(knowledgeEntries.isPublished, filter.isPublished));
    }
    if (filter.category) {
      conditions.push(eq(knowledgeEntries.category, filter.category));
    }

    // Scope condition
    if (filter.scope.type === 'products') {
      conditions.push(
        inArray(knowledgeEntries.productId, filter.scope.productIds),
      );
    } else {
      conditions.push(isNull(knowledgeEntries.productId));
    }

    // Searchable expression — mirrors the GIN pg_trgm index defined in
    // knowledge-entry.entity.ts. Drizzle renders the columns table-qualified
    // here vs. bare in the index DDL, but Postgres normalizes both to the same
    // expression node, so the index still applies.
    const searchable = sql`(coalesce(${knowledgeEntries.title}, '') || ' ' || coalesce(${knowledgeEntries.situation}, '') || ' ' || coalesce(${knowledgeEntries.content}, ''))`;

    const limit = filter.limit ?? 5;

    return this.tenantDb.tx(async (db) => {
      // No free-text query: pure structured filter, ordered by priority then recency.
      if (!filter.query) {
        return db
          .select()
          .from(knowledgeEntries)
          .where(and(...conditions))
          .orderBy(
            sql`${knowledgeEntries.priority} DESC`,
            sql`${knowledgeEntries.createdAt} DESC`,
          )
          .limit(limit);
      }

      // Fuzzy path — per-token, WORD-level match (Arabic-aware), mirroring
      // products.repository.searchFuzzy. `word_similarity(token, searchable)` finds
      // a token INSIDE the concatenated text ("عباية" scores ~1.0 against a long
      // entry) where whole-string `similarity()` cannot. ILIKE adds exact-substring
      // hits trigrams miss. WORD_SIM 0.5 keeps unrelated words out. The function
      // form of word_similarity needs no GUC, so — unlike the old `%` operator —
      // no transaction / SET LOCAL is required for the similarity search itself
      // (this method now always runs inside TenantDb's tx for tenant scoping).
      // All values are bound parameters.
      const q = filter.query;
      const tokens = tokenizeSearchQuery(q);

      const WORD_SIM = 0.5;
      const tokenConds = tokens.map(
        (t) => sql`(
          word_similarity(${t}, ${searchable}) >= ${WORD_SIM}
          OR ${searchable} ILIKE ${'%' + t + '%'}
        )`,
      );

      // Coarse whole-query trigram clause kept as an extra OR (helps short queries);
      // with no usable tokens (all-stopword query) it is the only text condition.
      const wholeQuery = sql`(similarity(${searchable}, ${q}) >= 0.2)`;

      const textCondition =
        tokenConds.length > 0
          ? sql`(${sql.join([...tokenConds, wholeQuery], sql` OR `)})`
          : wholeQuery;

      return db
        .select()
        .from(knowledgeEntries)
        .where(and(...conditions, textCondition))
        .orderBy(
          sql`${knowledgeEntries.priority} DESC`,
          sql`greatest(word_similarity(${q}, ${searchable}), similarity(${searchable}, ${q})) DESC`,
        )
        .limit(limit);
    });
  }
}
