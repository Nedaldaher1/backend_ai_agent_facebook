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
 *
 * Image URL strategy: `products.image_urls` stores STORAGE KEYS (not full URLs).
 * URLs are resolved via `storage.getUrl(key)` at the outward boundaries listed
 * below. Internal reads (repository, checkAvailability helpers) stay raw (keys).
 * Resolution boundaries — exactly once, never double-resolved:
 *   - getPublishedById (HTTP GET /products/:id)
 *   - search           (HTTP GET /products)
 *   - listPublished    (paginated customer/agent catalog)
 *   - addImages        (HTTP POST /products/:id/images — admin response)
 *   - getMedia         (agent tool get_product_media)
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
   * Outward boundary: backs HTTP GET /products (serialized as ProductDto, which
   * includes image_urls), so image keys are resolved to public URLs here.
   */
  async search(input: ProductSearchInput): Promise<Product[]> {
    const filter = await this.toPublishedFilter(input);
    const items = await this.repo.list(filter);
    return Promise.all(items.map((p) => this.resolveImageUrls(p)));
  }

  /**
   * Paginated published catalog (agent/customer); never returns drafts.
   * Outward boundary: image keys are resolved to public URLs on each item.
   */
  async listPublished(
    input: ProductSearchInput = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<Product>> {
    const filter = await this.toPublishedFilter(input);
    const page = await this.paginate(filter, opts);
    const items = await Promise.all(
      page.items.map((p) => this.resolveImageUrls(p)),
    );
    return { ...page, items };
  }

  /**
   * Fetch a single published product with image keys resolved to public URLs.
   * This is an outward HTTP boundary — callers receive URLs, not storage keys.
   * Internal callers that do not need URLs should call `findPublishedRaw`.
   */
  async getPublishedById(id: string): Promise<Product> {
    const product = await this.findPublishedRaw(id);
    return this.resolveImageUrls(product);
  }

  /**
   * Normalize a raw (possibly dialect) color term to a canonical color family.
   * Delegates to ColorSynonymsService: exact → fuzzy → raw-term fallback.
   */
  normalizeColor(term: string): Promise<string> {
    return this.colors.normalizeColor(term);
  }

  /**
   * Return published products linked to a Facebook ad reference slug.
   * Used by search_products to surface ad-specific products first.
   * Returns raw products (keys, not URLs) — imageUrls are not surfaced by the tool.
   */
  findByAdRef(adRef: string): Promise<Product[]> {
    return this.repo.findByAdRef(adRef);
  }

  /**
   * Fuzzy-text search over the published catalog; falls back to structured
   * search when `query` is empty/absent.
   * Returns raw products (keys, not URLs) — imageUrls are not in the tool output.
   *
   * NOTE: tool's `category` input maps to `occasion` on the product row —
   * there is no separate `category` column. This is intentional (documented
   * on the search tool too).
   */
  async searchFuzzy(
    query: string,
    input: ProductSearchInput = {},
  ): Promise<Product[]> {
    const filter = await this.toPublishedFilter(input);
    return this.repo.searchFuzzy(query, filter);
  }

  /**
   * Check whether a product is available and which sizes are in stock.
   * Always enforces the publish gate: an unpublished product is treated as
   * unavailable so the agent never surfaces it.
   * Uses findPublishedRaw to avoid resolving URLs (product here is internal only).
   *
   * @param productId  UUID of the product to check.
   * @param size       Optional requested size; narrows `available` to that size.
   */
  async checkAvailability(
    productId: string,
    size?: string,
  ): Promise<{
    available: boolean;
    inStockSizes: string[];
    note?: string;
    product?: Product;
  }> {
    let product: Product | undefined;
    try {
      // findPublishedRaw: raw keys, no URL resolution (internal consumer).
      product = await this.findPublishedRaw(productId);
    } catch {
      return { available: false, inStockSizes: [], note: 'المنتج غير متوفر' };
    }

    let available = product.stockStatus !== 'out';
    const inStockSizes = available ? (product.sizes ?? []) : [];

    if (size !== undefined) {
      available = available && inStockSizes.includes(size);
    }

    // Return the product too so write callers (capture_order) can read its
    // price/name without a second fetch.
    return { available, inStockSizes, product };
  }

  /**
   * Return the media (images) for a published product, with keys resolved to
   * public URLs. This is an agent-facing outward boundary.
   * Returns an empty array for unpublished or missing products.
   */
  async getMedia(productId: string): Promise<{ url: string; type: string }[]> {
    let product: Product | undefined;
    try {
      // findPublishedRaw: get raw keys first, then resolve below.
      product = await this.findPublishedRaw(productId);
    } catch {
      return [];
    }
    const keys = product.imageUrls ?? [];
    const urls = await Promise.all(keys.map((key) => this.storage.getUrl(key)));
    return urls.map((url) => ({ url, type: 'image' }));
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
   * Persist uploaded image files through the storage layer and record their
   * STORAGE KEYS on the product (not full URLs — keys are resolved to URLs on
   * read). Appends by default; `replace` overwrites image_urls. The product
   * must exist first so files are never orphaned for a missing product; if it
   * vanishes mid-write, the just-saved files are cleaned up.
   *
   * The returned product has its keys resolved to public URLs (admin boundary).
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
    // Persist KEYS (not URLs) so a future storage/domain change needs no data
    // migration. NOTE: rows created under the old `fs` driver hold absolute URLs
    // and must be backfilled to keys separately. URLs are resolved below before
    // returning to the caller.
    const keys = saved.map((s) => s.key);

    const updated = replace
      ? await this.repo.updateById(id, { imageUrls: keys })
      : await this.repo.appendImageUrls(id, keys);

    if (!updated) {
      // Product was deleted between the existence check and the write — undo the
      // just-saved files so they don't leak.
      await Promise.allSettled(
        saved.map((s) => this.storage.deleteImage(s.key)),
      );
      throw new NotFoundException(`Product ${id} not found`);
    }
    // Resolve keys → URLs for the admin response (outward boundary).
    return this.resolveImageUrls(updated);
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

  /**
   * Fetch a single published product WITHOUT resolving image keys to URLs.
   * Used internally by checkAvailability and getMedia so they can choose
   * independently whether to resolve (getMedia does; checkAvailability does not).
   * Throws NotFoundException for missing or unpublished products.
   */
  private async findPublishedRaw(id: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product || !product.isPublished) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  /**
   * Resolve a product's image_urls (storage keys) to public URLs in-place.
   * Returns a new object with `imageUrls` replaced by the resolved URL strings.
   * No-op when imageUrls is empty or null.
   * Called exactly once, only at outward HTTP/agent boundaries.
   */
  private async resolveImageUrls(product: Product): Promise<Product> {
    const keys = product.imageUrls;
    if (!keys || keys.length === 0) return product;
    const urls = await Promise.all(keys.map((k) => this.storage.getUrl(k)));
    return { ...product, imageUrls: urls };
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
