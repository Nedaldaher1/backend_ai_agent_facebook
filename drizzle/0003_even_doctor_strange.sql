CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "situation" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_entries_product_id_idx" ON "knowledge_entries" USING btree ("product_id") WHERE "knowledge_entries"."is_published";--> statement-breakpoint
CREATE INDEX "knowledge_entries_search_trgm_idx" ON "knowledge_entries" USING gin ((coalesce("title", '') || ' ' || coalesce("situation", '') || ' ' || coalesce("content", '')) gin_trgm_ops);