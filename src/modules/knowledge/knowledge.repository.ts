import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  type SQL,
} from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  knowledgeEntries,
  type KnowledgeEntry,
  type NewKnowledgeEntry,
} from './entities/knowledge-entry.entity';

/**
 * Filters for knowledge_entries. `isPublished` is explicit so the publish gate
 * is the caller's decision (service): the agent path forces `true`, admin omits
 * it. `search` matches title OR content; `tags` uses array overlap.
 */
export interface KnowledgeFilter {
  category?: string;
  isPublished?: boolean;
  tags?: string[];
  search?: string;
}

/**
 * Sole owner of knowledge_entries SQL. Query-builder only; the publish gate is a
 * filter the service sets, not a rule invented here. Ordered by priority then
 * recency so the agent retrieves the most relevant entries first.
 */
@Injectable()
export class KnowledgeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

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

    return conditions;
  }

  async list(
    filter: KnowledgeFilter = {},
    opts: ListOptions = {},
  ): Promise<KnowledgeEntry[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const recency = orderBy === 'asc' ? asc : desc;
    const conditions = this.buildConditions(filter);

    return this.db
      .select()
      .from(knowledgeEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        desc(knowledgeEntries.priority),
        recency(knowledgeEntries.createdAt),
      )
      .limit(limit)
      .offset(offset);
  }

  async count(filter: KnowledgeFilter = {}): Promise<number> {
    const conditions = this.buildConditions(filter);
    const [row] = await this.db
      .select({ value: count() })
      .from(knowledgeEntries)
      .where(conditions.length ? and(...conditions) : undefined);
    return row?.value ?? 0;
  }

  async findById(id: string): Promise<KnowledgeEntry | undefined> {
    const [row] = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .limit(1);
    return row;
  }

  async insert(input: NewKnowledgeEntry): Promise<KnowledgeEntry> {
    const [row] = await this.db
      .insert(knowledgeEntries)
      .values(input)
      .returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewKnowledgeEntry>,
  ): Promise<KnowledgeEntry | undefined> {
    const [row] = await this.db
      .update(knowledgeEntries)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(knowledgeEntries.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<KnowledgeEntry | undefined> {
    const [row] = await this.db
      .delete(knowledgeEntries)
      .where(eq(knowledgeEntries.id, id))
      .returning();
    return row;
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<KnowledgeEntry | undefined> {
    const [row] = await this.db
      .update(knowledgeEntries)
      .set({ isPublished, updatedAt: new Date() })
      .where(eq(knowledgeEntries.id, id))
      .returning();
    return row;
  }
}
