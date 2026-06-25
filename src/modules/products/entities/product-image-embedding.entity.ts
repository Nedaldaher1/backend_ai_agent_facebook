import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { products } from './product.entity';

/**
 * Per-image visual embedding for catalog products. Written best-effort by the
 * products write-path (on publish / image-set change) and by the backfill
 * script; read by the agent's `find_similar_by_image` via cosine ANN search.
 *
 * One row per (product, image_key). `embedding` is an L2-normalized 1536-d
 * vector produced by gemini-embedding-2 (image + admin description, via
 * OpenRouter); search ranks by cosine distance (`<=>` / `vector_cosine_ops`).
 * `model_id` records which model/version produced the vector so a model swap can
 * be detected and re-embedded. The unique (product_id, image_key) lets
 * re-embedding UPSERT instead of duplicating.
 *
 * NOTE: the 1536 literal must match EMBEDDING_DIM and the HNSW index (1536 is
 * within pgvector's 2000-dim hnsw cap). `CREATE EXTENSION vector` + the HNSW
 * cosine index are raw SQL (drizzle-kit emits neither); the 0009 migration
 * created them at 768, and the dim-change migration drops the index, retypes to
 * vector(1536), and rebuilds it. This entity stays the typed source of truth for
 * the columns and the unique/btree indexes.
 */
export const productImageEmbeddings = pgTable(
  'product_image_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    // R2 storage key the embedding was computed from. Resolved to a public URL
    // via StorageService.getUrl(key) at embed time; kept here for dedupe/re-embed.
    imageKey: text('image_key').notNull(),
    // L2-normalized embedding. The 1536 dimension must match EMBEDDING_DIM and
    // the vector_cosine_ops HNSW index (1536 ≤ pgvector's 2000-dim hnsw cap).
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    // Model+version that produced this vector (e.g. 'google/gemini-embedding-2').
    modelId: text('model_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Re-embedding upserts on this key instead of duplicating per image.
    uniqueIndex('product_image_embeddings_product_image_idx').on(
      t.productId,
      t.imageKey,
    ),
    // Supports per-product lookups (delete-missing keys, backfill checks).
    index('product_image_embeddings_product_id_idx').on(t.productId),
  ],
);

export const insertProductImageEmbeddingSchema = createInsertSchema(
  productImageEmbeddings,
);
export const selectProductImageEmbeddingSchema = createSelectSchema(
  productImageEmbeddings,
);

export type ProductImageEmbedding = typeof productImageEmbeddings.$inferSelect;
export type NewProductImageEmbedding =
  typeof productImageEmbeddings.$inferInsert;
