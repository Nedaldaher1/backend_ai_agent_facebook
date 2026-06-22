import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ListOptions, PaginatedResult } from '@/common/types/query';
import { normalizeListOptions } from '@/common/types/query';
import { assertPublicHttpUrl } from '@/common/net/url-safety';
import {
  createProductSchema,
  parseOrThrow,
  setImageColorsSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from '@/common/validation';
import { StorageService } from '@/core/storage/storage.service';
import { EmbeddingService } from '@/modules/embeddings/embedding.service';
import { ImageDecodeError } from '@/modules/embeddings/image-decode.error';
import { ColorSynonymsService } from './color-synonyms.service';
import { ColorsService } from './colors.service';
import { ProductImageColorsRepository } from './product-image-colors.repository';
import { ProductImageEmbeddingsRepository } from './product-image-embeddings.repository';
import { ProductsRepository, type ProductFilter } from './products.repository';
import type { Product } from './entities/product.entity';

/** Public list filters. `isPublished` is honored only on the admin path. */
export type ProductListFilter = ProductFilter;

/**
 * Resolved product data required to construct an order line item.
 *
 * `storageKey` is the primary image key (image_urls[0]). `capture_order` uses
 * this as the `storage_key` per item — it identifies the product's color
 * variant (each color is its own product row) and pins the order to that
 * variant. `capture_order` re-validates everything server-side; this resolver
 * is a pre-flight check only.
 *
 * NOTE: storageKey is a STORAGE KEY (not a public URL). Do NOT call
 * resolveImageUrls/storage.getUrl here — callers that need public URLs must
 * resolve independently at their own outward boundary.
 */
export interface OrderReadyProduct {
  productId: string;
  storageKey: string;
  name: string;
  priceJod: string;
  colorFamily: string | null;
  available: boolean;
  availableSizes: string[];
}

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

/** A canonical color as attached to a product image. */
export interface ImageColorBrief {
  id: string;
  name: string;
  family: string;
  hex: string | null;
}

/** One product image: storage key, resolved public URL, primary flag, colors. */
export interface ImageWithColors {
  key: string;
  url: string;
  isPrimary: boolean;
  colors: ImageColorBrief[];
  /**
   * Whether this image has a CLIP embedding for the current model (i.e. it is
   * indexed for visual search). Reported by `listImages`; other producers of
   * this shape may omit it.
   */
  hasEmbedding?: boolean;
}

/**
 * One visual-search hit: the product fields the agent needs, the primary image
 * resolved to a public URL, and the cosine similarity [0..1] of the best
 * matching image. `priceJod` stays a string (money-as-string end-to-end).
 */
export interface SimilarProduct {
  id: string;
  name: string;
  priceJod: string;
  colorFamily: string | null;
  occasion: string | null;
  stockStatus: string;
  imageUrl: string;
  similarity: number;
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
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly repo: ProductsRepository,
    // `colors` is the synonym/normalization service (dialect term -> family);
    // `colorsService` is the canonical-color registry (the `colors` table).
    private readonly colors: ColorSynonymsService,
    private readonly storage: StorageService,
    private readonly colorsService: ColorsService,
    private readonly imageColors: ProductImageColorsRepository,
    private readonly embeddingService: EmbeddingService,
    private readonly embeddings: ProductImageEmbeddingsRepository,
    private readonly config: ConfigService,
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
   * Distinct published values for a free-text attribute (occasion/fabric).
   * Used to build the soft vocabulary that guides vision attribute extraction.
   */
  distinctPublishedAttribute(
    attribute: 'occasion' | 'fabric',
  ): Promise<string[]> {
    return this.repo.distinctPublishedAttribute(attribute);
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
   * Resolve a published product to the data needed to construct an order item.
   *
   * This is the SINGLE authoritative resolver for product_id → order key.
   * It enforces two gates before returning order-ready data:
   *   1. Publish gate: unpublished / missing products are never orderable.
   *   2. Image gate: products with no images cannot be pinned to a storage key,
   *      so they are also treated as not found.
   *
   * The `storageKey` returned is image_urls[0] — the primary image key that
   * identifies the product's color variant. `capture_order` accepts this key
   * as `storage_key` and re-validates everything server-side; this resolver is
   * a pre-flight convenience so the agent knows what to pass.
   *
   * NOTE: returns `{ found: false }` (never throws) for missing/unpublished
   * products or products without images — the agent should surface a different
   * product rather than failing hard. Returns STORAGE KEYS, not public URLs.
   *
   * @param productId  UUID of the product to resolve.
   */
  async resolveForOrder(
    productId: string,
  ): Promise<{ found: false } | { found: true; product: OrderReadyProduct }> {
    let product: Product;
    try {
      product = await this.findPublishedRaw(productId);
    } catch {
      return { found: false };
    }

    const storageKey = product.imageUrls?.[0];
    if (!storageKey) {
      // Product has no images — cannot pin an order key without one.
      return { found: false };
    }

    const available = product.stockStatus !== 'out';
    return {
      found: true,
      product: {
        productId: product.id,
        storageKey,
        name: product.name,
        priceJod: product.priceJod,
        colorFamily: product.colorFamily,
        available,
        availableSizes: available ? (product.sizes ?? []) : [],
      },
    };
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

  /**
   * Resolve the canonical color name(s) attached to one product image
   * (productId + storageKey), joined for a clean snapshot. Returns null when the
   * image carries no color tag. Used by order capture to snapshot color_name —
   * the chosen image identifies the model's color via product_image_colors.
   */
  async getImageColorName(
    productId: string,
    storageKey: string,
  ): Promise<string | null> {
    const rows = await this.imageColors.findColorsByImage(productId, storageKey);
    if (rows.length === 0) return null;
    return rows.map((r) => r.name).join('، ');
  }

  /**
   * Visual search: embed the customer's image and return the closest PUBLISHED
   * products (one row per product, ranked by its best matching image). Matches
   * below SIMILARITY_MIN_SCORE are dropped so the agent never surfaces a weak
   * guess — an empty array is a valid, expected result. Outward boundary: the
   * primary image key is resolved to a public URL.
   *
   * `opts.targetColor` is a raw (possibly dialect) color term; when provided it
   * is normalized to a color family via color_synonyms and the ANN search is
   * scoped to products of that family BEFORE the LIMIT — only the closest images
   * OF THAT COLOR are ranked. An unrecognized color (resolveColorFamily returns
   * null) falls back to an unfiltered visual search, matching toPublishedFilter
   * behaviour. An empty result is always valid.
   */
  async findSimilarByImage(
    imageUrl: string,
    opts?: { limit?: number; targetColor?: string },
  ): Promise<SimilarProduct[]> {
    // SSRF guard: imageUrl is the customer-supplied URL fed to the embedding
    // fetch below. Validate before it reaches internal hosts / cloud metadata.
    // The find_similar_by_image tool catches a throw and returns an empty result.
    await assertPublicHttpUrl(imageUrl);

    const k = opts?.limit ?? this.config.get<number>('SIMILARITY_TOP_K') ?? 6;
    const minScore = this.config.get<number>('SIMILARITY_MIN_SCORE') ?? 0;

    // Normalize the requested color family via color_synonyms (mirrors toPublishedFilter).
    // resolveColorFamily returns null for unrecognized terms → no color filter applied.
    let colorFamily: string | undefined;
    if (opts?.targetColor) {
      colorFamily =
        (await this.colors.resolveColorFamily(opts.targetColor)) ?? undefined;
    }

    const vector = await this.embeddingService.embedImage(imageUrl);
    const rows = await this.embeddings.searchSimilarByEmbedding(vector, k, {
      colorFamily,
    });

    const hits = rows.filter((r) => r.similarity >= minScore);
    return Promise.all(
      hits.map(async (r) => ({
        id: r.productId,
        name: r.name,
        priceJod: r.priceJod,
        colorFamily: r.colorFamily,
        occasion: r.occasion,
        stockStatus: r.stockStatus,
        // Prefer the product's primary image (index 0); fall back to the matched one.
        imageUrl: await this.storage.getUrl(r.imageUrls?.[0] ?? r.imageKey),
        similarity: r.similarity,
      })),
    );
  }

  // --- Admin read path (drafts visible) ---

  /** Admin listing. Pass `filter.isPublished` to narrow; omit to see all. */
  list(
    filter: ProductListFilter = {},
    opts?: ListOptions,
  ): Promise<PaginatedResult<Product>> {
    return this.paginate(filter, opts);
  }

  /**
   * Per-product embedded-image counts (current model) for the admin product
   * list's "indexed for visual search" badge. One grouped query for the whole
   * page; products with no embeddings are omitted (treat a missing id as 0).
   */
  embeddingSummary(): Promise<{ productId: string; embeddedCount: number }[]> {
    return this.embeddings.countEmbeddedByProduct(this.embeddingService.modelId);
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
    // Validate synchronously (callers/tests rely on a sync throw on bad input),
    // then persist and best-effort embed.
    const data = parseOrThrow(createProductSchema, input);
    return this.repo.insert({ isPublished: false, ...data }).then((product) => {
      // Covers the rare create-as-published-with-images path (no-op for drafts).
      this.scheduleEmbeddingSync(product);
      return product;
    });
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
    // Image set changed — refresh embeddings best-effort (non-blocking).
    this.scheduleEmbeddingSync(updated);
    // Resolve keys → URLs for the admin response (outward boundary).
    return this.resolveImageUrls(updated);
  }

  /**
   * Run an uploaded image through the embedding model (a real SigLIP forward
   * pass) to validate it is processable — backs the admin form's per-image
   * "analyzed" indicator. Stateless: the vector is computed and discarded (the
   * persisted, searchable embedding is written on publish).
   *
   * Error mapping: an undecodable image is bad client input, so it surfaces as
   * 422 with the stable `code: 'IMAGE_UNREADABLE'` (the frontend distinguishes
   * it from a transient server error). Only ImageDecodeError is translated —
   * any other failure (e.g. the model forward pass) propagates to Nest's default
   * 500 so genuine server faults are not masked.
   */
  async analyzeImage(
    buffer: Buffer,
  ): Promise<{ analyzed: true; modelId: string }> {
    try {
      await this.embeddingService.embedImage(buffer);
    } catch (err) {
      if (err instanceof ImageDecodeError) {
        throw new UnprocessableEntityException({
          code: 'IMAGE_UNREADABLE',
          message: 'الصورة غير قابلة للقراءة',
        });
      }
      throw err;
    }
    return { analyzed: true, modelId: this.embeddingService.modelId };
  }

  async delete(id: string): Promise<Product> {
    const product = await this.repo.deleteById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  /**
   * List all images for a product, with storage keys resolved to public URLs and
   * each image's attached canonical colors. The first entry (index 0) is flagged
   * as `isPrimary`. Returns an empty array when the product has no images.
   * Admin boundary: does not enforce the publish gate.
   */
  async listImages(id: string): Promise<ImageWithColors[]> {
    const product = await this.repo.findById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const keys = product.imageUrls ?? [];
    if (keys.length === 0) return [];

    // One query for all image-color tags, then group by storage key.
    const colorRows = await this.imageColors.findColorsByProduct(id);
    const colorsByKey = new Map<string, ImageColorBrief[]>();
    for (const row of colorRows) {
      const list = colorsByKey.get(row.storageKey) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        family: row.family,
        hex: row.hex,
      });
      colorsByKey.set(row.storageKey, list);
    }

    // Per-image embedding status for the admin UI. Embeddings exist only for
    // published products (they are cleared on unpublish), so skip the query for
    // drafts — every image there is simply "not yet indexed".
    const embeddedKeys = product.isPublished
      ? new Set(
          await this.embeddings.findEmbeddedKeys(
            id,
            this.embeddingService.modelId,
          ),
        )
      : new Set<string>();

    return Promise.all(
      keys.map(async (key, i) => ({
        key,
        url: await this.storage.getUrl(key),
        isPrimary: i === 0,
        colors: colorsByKey.get(key) ?? [],
        hasEmbedding: embeddedKeys.has(key),
      })),
    );
  }

  /**
   * Replace the full set of canonical colors attached to one product image.
   * Validates the payload, that the image (storage key) belongs to the product,
   * and that every color id exists (clean 404, never an opaque FK error), then
   * swaps the image's color set atomically. Returns the image descriptor with the
   * storage key resolved to a public URL.
   *
   * Admin boundary: does not enforce the publish gate (drafts are editable).
   */
  async setImageColors(
    id: string,
    storageKey: string,
    input: { colorIds: string[] },
  ): Promise<ImageWithColors> {
    const { colorIds } = parseOrThrow(setImageColorsSchema, input);
    const product = await this.repo.findById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const keys = product.imageUrls ?? [];
    if (!keys.includes(storageKey)) {
      throw new NotFoundException(
        `Image key '${storageKey}' not found on product ${id}`,
      );
    }

    // De-duplicate (the composite PK forbids the same color twice on one image)
    // and assert every color exists before touching the join table.
    const uniqueIds = [...new Set(colorIds)];
    const colorRows = await this.colorsService.getManyByIds(uniqueIds);
    await this.imageColors.replaceForImage(id, storageKey, uniqueIds);

    return {
      key: storageKey,
      url: await this.storage.getUrl(storageKey),
      isPrimary: keys[0] === storageKey,
      colors: colorRows.map((c) => ({
        id: c.id,
        name: c.name,
        family: c.family,
        hex: c.hex,
      })),
    };
  }

  /**
   * Delete a single image from a product:
   *   1. Load the product (404 if missing).
   *   2. Verify the key is in `imageUrls` (404 if not found).
   *   3. Delete the object from storage.
   *   4. Persist the shortened key array via the repository.
   * Returns the updated product with keys resolved to public URLs.
   */
  async removeImage(id: string, key: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const keys = product.imageUrls ?? [];
    if (!keys.includes(key)) {
      throw new NotFoundException(`Image key '${key}' not found on product ${id}`);
    }
    // Delete the R2/storage object first; then drop the image's color tags so no
    // orphan rows linger (they would also RESTRICT-block deleting those colors);
    // finally update the DB row.
    await this.storage.deleteImage(key);
    await this.imageColors.deleteForImage(id, key);
    const remaining = keys.filter((k) => k !== key);
    const updated = await this.repo.updateById(id, { imageUrls: remaining });
    if (!updated) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    // Image set changed — refresh embeddings best-effort (non-blocking).
    this.scheduleEmbeddingSync(updated);
    return this.resolveImageUrls(updated);
  }

  /**
   * Promote an image key to be the primary (first) image by reordering the
   * `imageUrls` array so the given key appears at index 0. The remaining keys
   * keep their relative order. 404 when the product or the key is missing.
   */
  async setPrimaryImage(id: string, key: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    const keys = product.imageUrls ?? [];
    if (!keys.includes(key)) {
      throw new NotFoundException(`Image key '${key}' not found on product ${id}`);
    }
    const reordered = [key, ...keys.filter((k) => k !== key)];
    const updated = await this.repo.updateById(id, { imageUrls: reordered });
    if (!updated) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return this.resolveImageUrls(updated);
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

  /**
   * Fire-and-forget embedding sync. Embeddings are a best-effort enhancement, not
   * a publish gate — this never blocks the admin response and never throws (a
   * failure, including the first-call model download, is logged and swallowed).
   * The product MUST carry RAW storage keys in `imageUrls` (not resolved URLs).
   */
  private scheduleEmbeddingSync(product: Product): void {
    void this.syncProductEmbeddings(product).catch((err: unknown) => {
      this.logger.warn(
        `embedding sync failed for product ${product.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * (Re)embed a published product's images and prune embeddings for images it no
   * longer has. Drafts are never embedded (they can't surface in search) — their
   * embeddings are cleared instead. Per-image failures are logged and skipped so
   * one bad image can't abort the rest. Public so the backfill script reuses it.
   */
  async syncProductEmbeddings(product: Product): Promise<void> {
    const keys = product.imageUrls ?? [];

    if (!product.isPublished) {
      await this.embeddings.deleteMissingKeys(product.id, []);
      return;
    }

    for (const key of keys) {
      try {
        const url = await this.storage.getUrl(key);
        const vector = await this.embeddingService.embedImage(url);
        await this.embeddings.upsert(
          product.id,
          key,
          vector,
          this.embeddingService.modelId,
        );
      } catch (err: unknown) {
        this.logger.warn(
          `embed image ${key} (product ${product.id}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Drop embeddings for images no longer present on the product.
    await this.embeddings.deleteMissingKeys(product.id, keys);
  }

  /**
   * Idempotent embedding backfill for every PUBLISHED product image (used by the
   * `embeddings:backfill` script). Walks published products in batches; for each
   * image NOT already embedded with the current model it embeds + upserts, and it
   * continues past per-image failures. Re-running is a no-op (already-embedded
   * keys are skipped). `log` reports {done}/{total} progress.
   */
  async backfillEmbeddings(
    log: (msg: string) => void = () => undefined,
    batchSize = 100,
  ): Promise<{
    total: number;
    embedded: number;
    skipped: number;
    failed: number;
  }> {
    const modelId = this.embeddingService.modelId;

    // Collect all published products (raw keys) in batches so a large catalog
    // doesn't load in one query.
    const published: Product[] = [];
    for (let offset = 0; ; offset += batchSize) {
      const batch = await this.repo.list(
        { isPublished: true },
        { limit: batchSize, offset },
      );
      published.push(...batch);
      if (batch.length < batchSize) break;
    }

    const total = published.reduce((n, p) => n + (p.imageUrls?.length ?? 0), 0);
    log(
      `backfill: ${published.length} published products, ${total} images, model ${modelId}`,
    );

    let done = 0;
    let embedded = 0;
    let skipped = 0;
    let failed = 0;

    for (const product of published) {
      const keys = product.imageUrls ?? [];
      if (keys.length === 0) continue;
      const already = new Set(
        await this.embeddings.findEmbeddedKeys(product.id, modelId),
      );
      for (const key of keys) {
        done++;
        if (already.has(key)) {
          skipped++;
          continue;
        }
        try {
          const url = await this.storage.getUrl(key);
          const vector = await this.embeddingService.embedImage(url);
          await this.embeddings.upsert(product.id, key, vector, modelId);
          embedded++;
        } catch (err: unknown) {
          failed++;
          log(
            `  ✗ ${product.id}/${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        log(
          `  [${done}/${total}] embedded=${embedded} skipped=${skipped} failed=${failed}`,
        );
      }
    }

    log(
      embedded === 0 && failed === 0
        ? `backfill: nothing to do — all ${total} images already embedded`
        : `backfill done: embedded=${embedded} skipped=${skipped} failed=${failed} (of ${total})`,
    );
    return { total, embedded, skipped, failed };
  }

  private async requirePublishUpdate(
    id: string,
    isPublished: boolean,
  ): Promise<Product> {
    const product = await this.repo.setPublished(id, isPublished);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    // Publish → (re)embed images; unpublish → clear embeddings. Best-effort.
    this.scheduleEmbeddingSync(product);
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
