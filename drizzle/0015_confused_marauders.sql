-- Switch image embeddings to gemini-embedding-2 (1536-d, image+text). The old
-- FashionSigLIP 768-d vectors are in an INCOMPATIBLE space and cannot be cast to
-- 1536-d, so we drop the HNSW index, truncate the table, retype the column, then
-- rebuild the index. All rows are re-created afterwards by `embeddings:backfill`.
-- (drizzle-kit only emits the ALTER; the index drop/rebuild + truncate are raw.)
DROP INDEX IF EXISTS "product_image_embeddings_embedding_idx";--> statement-breakpoint
TRUNCATE TABLE "product_image_embeddings";--> statement-breakpoint
ALTER TABLE "product_image_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(1536);--> statement-breakpoint
CREATE INDEX "product_image_embeddings_embedding_idx" ON "product_image_embeddings" USING hnsw ("embedding" vector_cosine_ops);