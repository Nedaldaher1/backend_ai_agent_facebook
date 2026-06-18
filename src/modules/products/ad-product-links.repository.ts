import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  adProductLinks,
  type AdProductLink,
  type NewAdProductLink,
} from './entities/ad-product-link.entity';

export interface AdProductLinkFilter {
  adRef?: string;
}

/**
 * Sole owner of ad_product_links SQL. The agent's ad-ref lookup path lives in
 * ProductsRepository.findByAdRef; this repository owns the admin CRUD surface
 * (list, insert, update, delete). Query-builder only; no business logic.
 */
@Injectable()
export class AdProductLinksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(
    filter: AdProductLinkFilter = {},
    opts: ListOptions = {},
  ): Promise<AdProductLink[]> {
    const { limit, offset } = normalizeListOptions(opts);
    const query = this.db
      .select()
      .from(adProductLinks)
      .orderBy(asc(adProductLinks.position), asc(adProductLinks.createdAt))
      .limit(limit)
      .offset(offset);

    if (filter.adRef !== undefined) {
      return query.where(eq(adProductLinks.adRef, filter.adRef));
    }
    return query;
  }

  async count(filter: AdProductLinkFilter = {}): Promise<number> {
    const query = this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(adProductLinks);

    const rows =
      filter.adRef !== undefined
        ? await query.where(eq(adProductLinks.adRef, filter.adRef))
        : await query;

    return rows[0]?.count ?? 0;
  }

  async findById(id: string): Promise<AdProductLink | undefined> {
    const [row] = await this.db
      .select()
      .from(adProductLinks)
      .where(eq(adProductLinks.id, id))
      .limit(1);
    return row;
  }

  async insert(input: NewAdProductLink): Promise<AdProductLink> {
    const [row] = await this.db
      .insert(adProductLinks)
      .values(input)
      .returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewAdProductLink>,
  ): Promise<AdProductLink | undefined> {
    const [row] = await this.db
      .update(adProductLinks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(adProductLinks.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<AdProductLink | undefined> {
    const [row] = await this.db
      .delete(adProductLinks)
      .where(eq(adProductLinks.id, id))
      .returning();
    return row;
  }
}
