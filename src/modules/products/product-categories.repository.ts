import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import { products } from './entities/product.entity';
import {
  productCategories,
  type NewProductCategory,
  type ProductCategory,
} from './entities/product-category.entity';

/**
 * Sole owner of `product_categories` SQL. Query-builder only; no business logic.
 * The admin CRUD used to manage clothing categories lives here; the agent reads
 * the same table (active categories + their attribute schemas) for search.
 */
@Injectable()
export class ProductCategoriesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** All categories, ordered by sort_order then name (admin + agent list). */
  async list(opts: ListOptions = {}): Promise<ProductCategory[]> {
    const { limit, offset } = normalizeListOptions(opts);
    return this.db
      .select()
      .from(productCategories)
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name))
      .limit(limit)
      .offset(offset);
  }

  /** Only active categories — the closed vocabulary the agent may surface. */
  async listActive(): Promise<ProductCategory[]> {
    return this.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.isActive, true))
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name));
  }

  async findById(id: string): Promise<ProductCategory | undefined> {
    const [row] = await this.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.id, id))
      .limit(1);
    return row;
  }

  async findBySlug(slug: string): Promise<ProductCategory | undefined> {
    const [row] = await this.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.slug, slug))
      .limit(1);
    return row;
  }

  async insert(input: NewProductCategory): Promise<ProductCategory> {
    const [row] = await this.db
      .insert(productCategories)
      .values(input)
      .returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewProductCategory>,
  ): Promise<ProductCategory | undefined> {
    const [row] = await this.db
      .update(productCategories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(productCategories.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<ProductCategory | undefined> {
    const [row] = await this.db
      .delete(productCategories)
      .where(eq(productCategories.id, id))
      .returning();
    return row;
  }

  /** How many products currently reference this category (delete guard). */
  async countProductsUsing(id: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(products)
      .where(eq(products.categoryId, id));
    return row?.value ?? 0;
  }
}
