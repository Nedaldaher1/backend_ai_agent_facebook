import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { ListOptions, PaginatedResult } from '@/common/types/query';
import { normalizeListOptions } from '@/common/types/query';
import { ColorSynonymsService } from './color-synonyms.service';
import { ProductsRepository, type ProductFilter } from './products.repository';
import {
  PRICE_JOD_REGEX,
  STOCK_STATUSES,
  type NewProduct,
  type Product,
} from './entities/product.entity';

/** Public list filters. `isPublished` is honored only on the admin path. */
export type ProductListFilter = ProductFilter;

export interface ProductSearchInput {
  /** Raw (possibly dialect) color term; normalized via color_synonyms. */
  color?: string;
  colorFamily?: string;
  size?: string;
  fabric?: string;
  occasion?: string;
  stockStatus?: string;
  tags?: string[];
  search?: string;
  priceMin?: string;
  priceMax?: string;
}

/**
 * Product business logic and the single cross-module surface (the agent and the
 * admin UI both call this, never the repository).
 *
 * Publish gate: agent/customer methods (`search`, `listPublished`,
 * `getPublishedById`) force `isPublished: true`; admin methods (`list`,
 * `getById`, create/update/delete/publish) see drafts. The gate is enforced here,
 * safe-by-default — the repository only applies the filter it is given.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly repo: ProductsRepository,
    private readonly colors: ColorSynonymsService,
  ) {}

  // --- Agent / customer read path (publish gate forced on) ---

  /**
   * Search the published catalog. A raw `color` term is normalized to a color
   * family through color_synonyms before filtering (e.g. "نبيتي" -> "red").
   */
  async search(input: ProductSearchInput): Promise<Product[]> {
    const filter = await this.toPublishedFilter(input);
    return this.repo.list(filter);
  }

  /** Paginated published catalog (agent/customer); never returns drafts. */
  async listPublished(
    input: ProductSearchInput = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<Product>> {
    const filter = await this.toPublishedFilter(input);
    return this.paginate(filter, opts);
  }

  /** Fetch a single product, enforcing the publish gate for customer-facing reads. */
  async getPublishedById(id: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product || !product.isPublished) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  // --- Admin read path (drafts visible) ---

  /** Admin listing. Pass `filter.isPublished` to narrow; omit to see all. */
  list(
    filter: ProductListFilter = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<Product>> {
    return this.paginate(filter, opts);
  }

  /** Admin single-product read; returns drafts too. */
  async getById(
    id: string,
    { publishedOnly = false }: { publishedOnly?: boolean } = {},
  ): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product || (publishedOnly && !product.isPublished)) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  // --- Admin write path ---

  /** Create a product. Defaults to a draft unless `isPublished` is set. */
  create(input: NewProduct): Promise<Product> {
    this.assertWritable(input);
    return this.repo.insert({ isPublished: false, ...input });
  }

  /** Back-compat alias for the original draft-creation entry point. */
  createDraft(input: NewProduct): Promise<Product> {
    this.assertWritable(input);
    return this.repo.insert({ ...input, isPublished: false });
  }

  async update(id: string, patch: Partial<NewProduct>): Promise<Product> {
    this.assertWritable(patch);
    const product = await this.repo.updateById(id, patch);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  async delete(id: string): Promise<Product> {
    const product = await this.repo.deleteById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  setPublished(id: string, isPublished: boolean): Promise<Product> {
    return this.requirePublishUpdate(id, isPublished);
  }

  publish(id: string): Promise<Product> {
    return this.requirePublishUpdate(id, true);
  }

  unpublish(id: string): Promise<Product> {
    return this.requirePublishUpdate(id, false);
  }

  /** Flip the publish flag; reads current state first so the toggle is correct. */
  async togglePublish(id: string): Promise<Product> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return this.requirePublishUpdate(id, !current.isPublished);
  }

  // --- internals ---

  /** Validate enum/money-shaped fields before they reach the database. */
  private assertWritable(input: Partial<NewProduct>): void {
    if (input.priceJod !== undefined && !PRICE_JOD_REGEX.test(input.priceJod)) {
      throw new BadRequestException(
        `Invalid JOD price "${input.priceJod}"; use a number with up to 3 decimals`,
      );
    }
    if (
      input.stockStatus !== undefined &&
      !z.enum(STOCK_STATUSES).safeParse(input.stockStatus).success
    ) {
      throw new BadRequestException(
        `Invalid stock status "${input.stockStatus}"; allowed: ${STOCK_STATUSES.join(', ')}`,
      );
    }
  }

  private async requirePublishUpdate(
    id: string,
    isPublished: boolean,
  ): Promise<Product> {
    const product = await this.repo.setPublished(id, isPublished);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  /** Build a published-only filter, normalizing a raw color term to a family. */
  private async toPublishedFilter(
    input: ProductSearchInput,
  ): Promise<ProductFilter> {
    let colorFamily = input.colorFamily;
    if (!colorFamily && input.color) {
      colorFamily =
        (await this.colors.resolveColorFamily(input.color)) ?? undefined;
    }

    return {
      isPublished: true,
      colorFamily,
      size: input.size,
      fabric: input.fabric,
      occasion: input.occasion,
      stockStatus: input.stockStatus,
      tags: input.tags,
      search: input.search,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
    };
  }

  /** Run list + count under the same filter and return a page envelope. */
  private async paginate(
    filter: ProductFilter,
    opts?: ListOptions,
  ): Promise<PaginatedResult<Product>> {
    const { limit, offset } = normalizeListOptions(opts);
    const [items, total] = await Promise.all([
      this.repo.list(filter, opts),
      this.repo.count(filter),
    ]);
    return { items, total, limit, offset };
  }
}
