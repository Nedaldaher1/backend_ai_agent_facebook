CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "product_image_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"image_key" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_image_embeddings" ADD CONSTRAINT "product_image_embeddings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_image_embeddings_product_image_idx" ON "product_image_embeddings" USING btree ("product_id","image_key");--> statement-breakpoint
CREATE INDEX "product_image_embeddings_product_id_idx" ON "product_image_embeddings" USING btree ("product_id");--> statement-breakpoint
-- HNSW cosine index for approximate-nearest-neighbour visual search (raw SQL:
-- drizzle-kit emits neither CREATE EXTENSION nor the hnsw index). 768 dims index
-- natively (well under pgvector's 2000-dim cap), so no halfvec is needed.
CREATE INDEX "product_image_embeddings_embedding_idx" ON "product_image_embeddings" USING hnsw ("embedding" vector_cosine_ops);