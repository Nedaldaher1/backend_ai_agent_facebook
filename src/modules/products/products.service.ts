import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ListOptions, PaginatedResult } from '@/common/types/query';
import { normalizeListOptions } from '@/common/types/query';
import {
  createProductSchema,
  parseOrThrow,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from '@/common/validation';
import { StorageService } from '@/core/storage/storage.service';
import { ColorSynonymsService } from './color-synonyms.service';
import { ProductsRepository, type ProductFilter } from './products.repository';
import type { Product } from './entities/product.entity';

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

/** In-memory file handed from the HTTP layer to storage (no temp files). */
export interface UploadedImage {
  buffer: Buffer;
  filename: string;
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
    private readonly storage: StorageService,
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
  create(input: CreateProductInput): Promise<Product> {
    const data = parseOrThrow(createProductSchema, input);
    return this.repo.insert({ isPublished: false, ...data });
  }

  /** Back-compat alias for the original draft-creation entry point. */
  createDraft(input: CreateProductInput): Promise<Product> {
    const data = parseOrThrow(createProductSchema, input);
    return this.repo.insert({ ...data, isPublished: false });
  }

  async update(id: string, patch: UpdateProductInput): Promise<Product> {
    const data = parseOrThrow(updateProductSchema, patch);
    const product = await this.repo.updateById(id, data);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  /**
   * Persist uploaded image files through the storage layer and record their URLs
   * on the product. Appends by default; `replace` overwrites image_urls. The
   * product must exist first so files are never orphaned for a missing product;
   * if it vanishes mid-write, the just-saved files are cleaned up.
   */
  async addImages(
    id: string,
    files: UploadedImage[],
    { replace = false }: { replace?: boolean } = {},
  ): Promise<Product> {
    if (files.length === 0) {
      throw new BadRequestException('No files were provided.');
    }
    if (!(await this.repo.findById(id))) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const saved = await Promise.all(
      files.map((f) => this.storage.saveImage(f.buffer, f.filename)),
    );
    const urls = saved.map((s) => s.url);

    const updated = replace
      ? await this.repo.updateById(id, { imageUrls: urls })
      : await this.repo.appendImageUrls(id, urls);

    if (!updated) {
      // Product was deleted between the existence check and the write — undo the
      // just-saved files so they don't leak.
      await Promise.allSettled(
        saved.map((s) => this.storage.deleteImage(s.key)),
      );
      throw new NotFoundException(`Product ${id} not found`);
    }
    return updated;
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
