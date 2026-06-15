import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions, PaginatedResult } from '@/common/types/query';
import { normalizeListOptions } from '@/common/types/query';
import {
  KnowledgeRepository,
  type KnowledgeFilter,
} from './knowledge.repository';
import type {
  KnowledgeEntry,
  NewKnowledgeEntry,
} from './entities/knowledge-entry.entity';

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

  create(input: NewKnowledgeEntry): Promise<KnowledgeEntry> {
    return this.repo.insert(input);
  }

  async update(
    id: string,
    patch: Partial<NewKnowledgeEntry>,
  ): Promise<KnowledgeEntry> {
    const row = await this.repo.updateById(id, patch);
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
