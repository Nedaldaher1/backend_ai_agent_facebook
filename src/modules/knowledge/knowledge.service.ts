import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions, PaginatedResult } from '@/common/types/query';
import { normalizeListOptions } from '@/common/types/query';
import {
  createKnowledgeEntrySchema,
  parseOrThrow,
  updateKnowledgeEntrySchema,
  type CreateKnowledgeEntryInput,
  type UpdateKnowledgeEntryInput,
} from '@/common/validation';
import {
  KnowledgeRepository,
  type KnowledgeFilter,
} from './knowledge.repository';
import type { KnowledgeEntry } from './entities/knowledge-entry.entity';

/**
 * Input for the agent's relevance retrieval path.
 * `productIds` narrows the search to product-specific entries for the currently
 * discussed product(s); omit it to get only global entries.
 */
export interface KnowledgeRelevanceInput {
  query?: string;
  productIds?: string[];
  category?: string;
}

/** Public filters for knowledge listing (admin honors `isPublished`). */
export type KnowledgeListFilter = Omit<KnowledgeFilter, never>;

/** Filters the agent may pass; the publish gate is forced on regardless. */
export type KnowledgeSearchInput = Omit<KnowledgeFilter, 'isPublished'>;

/**
 * Brand-knowledge logic and the single cross-module surface for FAQ/policy
 * retrieval.
 *
 * Publish gate: agent methods (`searchPublished`, `getPublishedById`) force
 * `isPublished: true`; admin methods see drafts. Enforced here, safe-by-default.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly repo: KnowledgeRepository) {}

  // --- Agent read path (publish gate forced on) ---

  /** Published knowledge for the agent; never returns drafts. */
  searchPublished(
    input: KnowledgeSearchInput = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<KnowledgeEntry>> {
    return this.paginate({ ...input, isPublished: true }, opts);
  }

  async getPublishedById(id: string): Promise<KnowledgeEntry> {
    const row = await this.repo.findById(id);
    if (!row || !row.isPublished) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return row;
  }

  /**
   * Retrieve the most relevant published knowledge entries for an agent turn.
   *
   * Tiering (product-specific first):
   *  1. If `productIds` is non-empty, fetch up to LIMIT product-specific entries
   *     (productId IN productIds, isPublished = true).
   *  2. Fill remaining slots (LIMIT − specific.length) from global entries
   *     (productId IS NULL, isPublished = true).
   *  3. Merge product-specific first, dedupe by id, cap at LIMIT.
   *
   * Publish gate: always forced to `true` here — callers cannot bypass it.
   * Cap: 5 entries maximum per turn (enough context without overloading the prompt).
   */
  async getRelevant(input: KnowledgeRelevanceInput): Promise<KnowledgeEntry[]> {
    const LIMIT = 5;

    // --- product-specific tier ---
    let specific: KnowledgeEntry[] = [];
    if (input.productIds?.length) {
      specific = await this.repo.findRelevant({
        scope: { type: 'products', productIds: input.productIds },
        isPublished: true,
        category: input.category,
        query: input.query,
        limit: LIMIT,
      });
    }

    // --- global tier (fills remaining slots) ---
    const remaining = LIMIT - specific.length;
    let global: KnowledgeEntry[] = [];
    if (remaining > 0) {
      global = await this.repo.findRelevant({
        scope: { type: 'global' },
        isPublished: true,
        category: input.category,
        query: input.query,
        limit: remaining,
      });
    }

    // Merge product-specific first, dedupe by id, cap at LIMIT.
    const seen = new Set(specific.map((e) => e.id));
    return [...specific, ...global.filter((e) => !seen.has(e.id))].slice(0, LIMIT);
  }

  // --- Admin read path (drafts visible) ---

  list(
    filter: KnowledgeListFilter = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<KnowledgeEntry>> {
    return this.paginate(filter, opts);
  }

  async getById(id: string): Promise<KnowledgeEntry> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return row;
  }

  // --- Admin write path ---

  create(input: CreateKnowledgeEntryInput): Promise<KnowledgeEntry> {
    const data = parseOrThrow(createKnowledgeEntrySchema, input);
    return this.repo.insert(data);
  }

  async update(
    id: string,
    patch: UpdateKnowledgeEntryInput,
  ): Promise<KnowledgeEntry> {
    const data = parseOrThrow(updateKnowledgeEntrySchema, patch);
    const row = await this.repo.updateById(id, data);
    if (!row) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<KnowledgeEntry> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return row;
  }

  setPublished(id: string, isPublished: boolean): Promise<KnowledgeEntry> {
    return this.requirePublishUpdate(id, isPublished);
  }

  async togglePublish(id: string): Promise<KnowledgeEntry> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return this.requirePublishUpdate(id, !current.isPublished);
  }

  // --- internals ---

  private async requirePublishUpdate(
    id: string,
    isPublished: boolean,
  ): Promise<KnowledgeEntry> {
    const row = await this.repo.setPublished(id, isPublished);
    if (!row) {
      throw new NotFoundException(`Knowledge entry ${id} not found`);
    }
    return row;
  }

  private async paginate(
    filter: KnowledgeFilter,
    opts?: ListOptions,
  ): Promise<PaginatedResult<KnowledgeEntry>> {
    const { limit, offset } = normalizeListOptions(opts);
    const [items, total] = await Promise.all([
      this.repo.list(filter, opts),
      this.repo.count(filter),
    ]);
    return { items, total, limit, offset };
  }
}
