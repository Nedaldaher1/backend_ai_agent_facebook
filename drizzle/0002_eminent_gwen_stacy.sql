CREATE TABLE "ad_product_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_ref" text NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_product_links" ADD CONSTRAINT "ad_product_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_product_links_ad_ref_product_id_idx" ON "ad_product_links" USING btree ("ad_ref","product_id");--> statement-breakpoint
CREATE INDEX "ad_product_links_ad_ref_active_idx" ON "ad_product_links" USING btree ("ad_ref") WHERE "ad_product_links"."is_active";--> statement-breakpoint
CREATE INDEX "ad_product_links_product_id_idx" ON "ad_product_links" USING btree ("product_id");