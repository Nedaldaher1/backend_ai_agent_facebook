ALTER TABLE "conversations" ADD COLUMN "ad_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ad_source" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ad_product_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ad_context" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "attributed_at" timestamp with time zone;