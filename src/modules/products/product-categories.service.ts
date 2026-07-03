import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createProductCategorySchema,
  parseOrThrow,
  updateProductCategorySchema,
  type CreateProductCategoryInput,
  type UpdateProductCategoryInput,
} from '@/common/validation';
import { ProductCategoriesRepository } from './product-categories.repository';
import type { ProductCategory } from './entities/product-category.entity';

/** Postgres SQLSTATE for a duplicate slug (product_categories_slug_idx). */
const PG_UNIQUE_VIOLATION = '23505';

function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === code
  );
}

function duplicateSlugMessage(slug: string | undefined): string {
  return (
    `A category with slug "${slug}" already exists. \`slug\` is the canonical ` +
    `key and must be unique across categories — pick a different slug, or edit ` +
    `the existing category instead of creating a new one.`
  );
}

/**
 * Clothing-category logic. Owns the admin CRUD for `product_categories` and the
 * existence checks the products path relies on, so a caller always gets a clean
 * 404/409 instead of an opaque driver error.
 *
 * A category cannot be deleted while products still reference it — the admin
 * must reassign or remove those products first (mirrors colors' RESTRICT guard,
 * but categories have no sentinel fallback).
 */
@Injectable()
export class ProductCategoriesService {
  constructor(private readonly repo: ProductCategoriesRepository) {}

  list(opts?: ListOptions): Promise<ProductCategory[]> {
    return this.repo.list(opts);
  }

  /** Active categories only — the vocabulary the agent may surface. */
  listActive(): Promise<ProductCategory[]> {
    return this.repo.listActive();
  }

  async getById(id: string): Promise<ProductCategory> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    return row;
  }

  /**
   * Assert a category id exists (used by ProductsService before writing a
   * product's category_id, for a clean 404 instead of an FK violation).
   */
  async assertExists(id: string): Promise<ProductCategory> {
    return this.getById(id);
  }

  /** Insert a category. Kept non-async so the validation throw stays sync. */
  create(input: CreateProductCategoryInput): Promise<ProductCategory> {
    const data = parseOrThrow(createProductCategorySchema, input);
    return this.repo.insert(data).catch((err: unknown) => {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(duplicateSlugMessage(data.slug));
      }
      throw err;
    });
  }

  async update(
    id: string,
    patch: UpdateProductCategoryInput,
  ): Promise<ProductCategory> {
    const data = parseOrThrow(updateProductCategorySchema, patch);
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    let row: ProductCategory | undefined;
    try {
      row = await this.repo.updateById(id, data);
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(duplicateSlugMessage(data.slug));
      }
      throw err;
    }
    if (!row) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    return row;
  }

  /**
   * Delete a category. Refuses (409) while any product still references it, so
   * products never end up pointing at a missing category.
   */
  async delete(id: string): Promise<{ deleted: true }> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    const inUse = await this.repo.countProductsUsing(id);
    if (inUse > 0) {
      throw new ConflictException(
        `Category ${id} ("${current.name}") is used by ${inUse} product(s). ` +
          `Reassign or remove those products before deleting the category.`,
      );
    }
    await this.repo.deleteById(id);
    return { deleted: true };
  }
}
