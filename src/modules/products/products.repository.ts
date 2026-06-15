import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  ilike,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  products,
  type NewProduct,
  type Product,
} from './entities/product.entity';

/**
 * Filters for the product catalog. `isPublished` is an explicit field so the
 * publish gate is decided by the caller (service): admin lists pass it through,
 * the agent path forces `true`. Price bounds are strings (numeric is a string
 * end-to-end) and are compared as numeric in SQL — never as floats or text.
 */
export interface ProductFilter {
  colorFamily?: string;
  size?: string;
  fabric?: string;
  occasion?: string;
  stockStatus?: string;
  tags?: string[];
  search?: string;
  priceMin?: string;
  priceMax?: string;
  isPublished?: boolean;
}

/**
 * Sole owner of product SQL. Services call these methods; nothing above this
 * layer touches the database or builds queries. No business logic here — the
 * publish gate is a filter the service sets, not a rule this layer invents.
 */
@Injectable()
export class ProductsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Translate a filter into a list of SQL conditions (parameterized). */
  private buildConditions(filter: ProductFilter): SQL[] {
    const conditions: SQL[] = [];

    if (filter.isPublished !== undefined) {
      conditions.push(eq(products.isPublished, filter.isPublished));
    }
    if (filter.colorFamily) {
      conditions.push(eq(products.colorFamily, filter.colorFamily));
    }
    if (filter.size) {
      conditions.push(arrayContains(products.sizes, [filter.size]));
    }
    if (filter.fabric) {
      conditions.push(eq(products.fabric, filter.fabric));
    }
    if (filter.occasion) {
      conditions.push(eq(products.occasion, filter.occasion));
    }
    if (filter.stockStatus) {
      conditions.push(eq(products.stockStatus, filter.stockStatus));
    }
    if (filter.tags && filter.tags.length > 0) {
      conditions.push(arrayOverlaps(products.tags, filter.tags));
    }
    if (filter.search) {
      conditions.push(ilike(products.name, `%${filter.search}%`));
    }
    // numeric(10,3) is returned/accepted as a string; compare as numeric in SQL
    // with bound parameters so the comparison is correct and never float math.
    if (filter.priceMin !== undefined) {
      conditions.push(sql`${products.priceJod} >= ${filter.priceMin}`);
    }
    if (filter.priceMax !== undefined) {
      conditions.push(sql`${products.priceJod} <= ${filter.priceMax}`);
    }

    return conditions;
  }

  /** List products matching `filter`, paginated and ordered by created_at. */
  async list(
    filter: ProductFilter = {},
    opts: ListOptions = {},
  ): Promise<Product[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    const conditions = this.buildConditions(filter);

    return this.db
      .select()
      .from(products)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(direction(products.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Total rows matching `filter` (for pagination), ignoring limit/offset. */
  async count(filter: ProductFilter = {}): Promise<number> {
    const conditions = this.buildConditions(filter);
    const [row] = await this.db
      .select({ value: count() })
      .from(products)
      .where(conditions.length ? and(...conditions) : undefined);
    return row?.value ?? 0;
  }

  /** Internal lookup (no publish gate); callers decide whether to expose it. */
  async findById(id: string): Promise<Product | undefined> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    return row;
  }

  async insert(input: NewProduct): Promise<Product> {
    const [row] = await this.db.insert(products).values(input).returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewProduct>,
  ): Promise<Product | undefined> {
    const [row] = await this.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<Product | undefined> {
    const [row] = await this.db
      .delete(products)
      .where(eq(products.id, id))
      .returning();
    return row;
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<Product | undefined> {
    const [row] = await this.db
      .update(products)
      .set({ isPublished, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row;
  }
}
