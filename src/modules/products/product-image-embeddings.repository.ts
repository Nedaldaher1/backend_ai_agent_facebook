import { Injectable } from '@nestjs/common';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { TenantDb } from '@/core/tenancy/tenant-db';
import { products } from './entities/product.entity';
import { productImageEmbeddings } from './entities/product-image-embedding.entity';
import { productImageColors } from './entities/product-image-color.entity';
import { colors } from './entities/color.entity';

/**
 * One product-image match from the ANN search: the product fields the agent
 * needs plus the best (closest) matching image and its similarity. `priceJod`
 * stays a string (money-as-string end-to-end). `similarity` is cosine in [0..1]
 * (1 − distance for L2-normalized vectors); `imageKey` is the single closest
 * image, `imageUrls` the full key list so the service can resolve a primary URL.
 */
export interface SimilarProductRow {
  productId: string;
  name: string;
  priceJod: string;
  colorFamily: string | null;
  stockStatus: string;
  imageKey: string;
  imageUrls: string[] | null;
  distance: number;
  similarity: number;
}

/**
 * Sole owner of `product_image_embeddings` SQL. Query-builder/raw-SQL only; no
 * business logic and no model inference (that lives in EmbeddingService). The
 * write-path (ProductsService) and the backfill script call the upsert/delete/
 * read helpers; the agent's visual search calls searchSimilarByEmbedding.
 */
@Injectable()
export class ProductImageEmbeddingsRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * Insert or refresh the embedding for one (product, image). Idempotent on the
   * unique (product_id, image_key): re-embedding the same image overwrites the
   * vector and stamps the producing model_id + updated_at.
   */
  async upsert(
    productId: string,
    imageKey: string,
    embedding: number[],
    modelId: string,
  ): Promise<void> {
    await this.tenantDb.tx(async (db) => {
      await db
        .insert(productImageEmbeddings)
        .values({ productId, imageKey, embedding, modelId })
        .onConflictDoUpdate({
          target: [
            productImageEmbeddings.productId,
            productImageEmbeddings.imageKey,
          ],
          set: { embedding, modelId, updatedAt: new Date() },
        });
    });
  }

  /**
   * Drop embeddings for images that are no longer on the product (so a removed
   * or replaced image doesn't linger in search). Passing an empty keep-list
   * clears all of the product's embeddings. Returns the number deleted.
   */
  async deleteMissingKeys(
    productId: string,
    keepImageKeys: string[],
  ): Promise<number> {
    return this.tenantDb.tx(async (db) => {
      const where =
        keepImageKeys.length === 0
          ? eq(productImageEmbeddings.productId, productId)
          : and(
              eq(productImageEmbeddings.productId, productId),
              notInArray(productImageEmbeddings.imageKey, keepImageKeys),
            );
      const deleted = await db
        .delete(productImageEmbeddings)
        .where(where)
        .returning({ id: productImageEmbeddings.id });
      return deleted.length;
    });
  }

  /** Image keys already embedded for this product with the given model (backfill idempotency). */
  async findEmbeddedKeys(
    productId: string,
    modelId: string,
  ): Promise<string[]> {
    return this.tenantDb.tx(async (db) => {
      const rows = await db
        .select({ imageKey: productImageEmbeddings.imageKey })
        .from(productImageEmbeddings)
        .where(
          and(
            eq(productImageEmbeddings.productId, productId),
            eq(productImageEmbeddings.modelId, modelId),
          ),
        );
      return rows.map((r) => r.imageKey);
    });
  }

  /** Total embedding rows (used by the backfill DoD check). */
  async count(): Promise<number> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(productImageEmbeddings);
      return row?.value ?? 0;
    });
  }

  /**
   * Embedded-image count per product for the given model. Powers the admin
   * product list's "indexed for visual search" badge in one grouped query.
   * Products with no embeddings are simply absent from the result — callers
   * treat a missing product id as a count of 0.
   */
  async countEmbeddedByProduct(
    modelId: string,
  ): Promise<{ productId: string; embeddedCount: number }[]> {
    return this.tenantDb.tx(async (db) => {
      return db
        .select({
          productId: productImageEmbeddings.productId,
          embeddedCount: sql<number>`count(*)::int`,
        })
        .from(productImageEmbeddings)
        .where(eq(productImageEmbeddings.modelId, modelId))
        .groupBy(productImageEmbeddings.productId);
    });
  }

  /**
   * Approximate-nearest-neighbour search over the HNSW cosine index, reduced to
   * distinct published products.
   *
   *  - `candidates`: the `overfetch` closest images overall — `ORDER BY embedding
   *    <=> query LIMIT overfetch` is what the HNSW index accelerates. Only
   *    published products are eligible (drafts never surface).
   *  - `best`: collapse to one row per product (its closest image) via
   *    DISTINCT ON (product_id).
   *  - final: re-rank those distinct products by distance and take `k`.
   *
   * Over-fetching (k*4 by default) leaves enough candidates that the per-product
   * dedupe still yields up to `k` distinct products. The query vector must be the
   * same dtype/normalization as the stored vectors.
   *
   * `opts.colorFamilies` narrows the search to specific color families BEFORE
   * the LIMIT so the HNSW scan only sees matching products. Variant-aware: a
   * product qualifies when its PRIMARY color_family matches OR any per-image
   * variant color does (product_image_colors → colors.family) — a light_green-
   * primary product with a beige variant image must survive a beige filter.
   * The filter is fully parameterized — never string-concatenated. An empty /
   * absent list disables the filter and returns results across all colors.
   */
  async searchSimilarByEmbedding(
    embedding: number[],
    k: number,
    opts: { overfetch?: number; colorFamilies?: string[] } = {},
  ): Promise<SimilarProductRow[]> {
    return this.tenantDb.tx(async (db) => {
      const overfetch = opts.overfetch ?? k * 4;
      const families = opts.colorFamilies ?? [];
      const familyList = sql.join(
        families.map((f) => sql`${f}`),
        sql`, `,
      );
      const colorFilter =
        families.length > 0
          ? sql`AND (p.color_family IN (${familyList}) OR EXISTS (
              SELECT 1 FROM ${productImageColors} AS pic
              JOIN ${colors} AS c ON c.id = pic.color_id
              WHERE pic.product_id = p.id AND c.family IN (${familyList})
            ))`
          : sql``;
      const vec = `[${embedding.join(',')}]`;
      const result = await db.execute(sql`
        WITH candidates AS (
          SELECT
            e.product_id,
            e.image_key,
            (e.embedding <=> ${vec}::vector) AS distance,
            p.name,
            p.price_jod,
            p.color_family,
            p.stock_status,
            p.image_urls
          FROM ${productImageEmbeddings} AS e
          JOIN ${products} AS p ON p.id = e.product_id
          WHERE p.is_published = true ${colorFilter}
          ORDER BY e.embedding <=> ${vec}::vector
          LIMIT ${overfetch}
        ),
        best AS (
          SELECT DISTINCT ON (product_id)
            product_id, image_key, distance, name, price_jod,
            color_family, stock_status, image_urls
          FROM candidates
          ORDER BY product_id, distance
        )
        SELECT * FROM best ORDER BY distance ASC LIMIT ${k}
      `);

      const rows = (result.rows ?? []) as Array<{
        product_id: string;
        image_key: string;
        distance: number | string;
        name: string;
        price_jod: string;
        color_family: string | null;
        stock_status: string;
        image_urls: string[] | null;
      }>;

      return rows.map((r) => {
        const distance = Number(r.distance);
        return {
          productId: r.product_id,
          name: r.name,
          priceJod: r.price_jod,
          colorFamily: r.color_family,
          stockStatus: r.stock_status,
          imageKey: r.image_key,
          imageUrls: r.image_urls,
          distance,
          similarity: 1 - distance,
        };
      });
    });
  }
}
