CREATE TABLE "colors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"hex" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_image_colors" (
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"color_id" uuid NOT NULL,
	CONSTRAINT "product_image_colors_product_id_storage_key_color_id_pk" PRIMARY KEY("product_id","storage_key","color_id")
);
--> statement-breakpoint
ALTER TABLE "color_synonyms" ALTER COLUMN "canonical_family" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "color_synonyms" ADD COLUMN "color_id" uuid;--> statement-breakpoint
ALTER TABLE "product_image_colors" ADD CONSTRAINT "product_image_colors_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_image_colors" ADD CONSTRAINT "product_image_colors_color_id_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."colors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "colors_family_idx" ON "colors" USING btree ("family");--> statement-breakpoint
CREATE INDEX "product_image_colors_color_id_idx" ON "product_image_colors" USING btree ("color_id");--> statement-breakpoint
ALTER TABLE "color_synonyms" ADD CONSTRAINT "color_synonyms_color_id_colors_id_fk" FOREIGN KEY ("color_id") REFERENCES "public"."colors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "color_synonyms_color_id_idx" ON "color_synonyms" USING btree ("color_id");--> statement-breakpoint
-- Backfill: promote each distinct canonical_family to a colors row (name defaults
-- to the family slug; admins can rename to Arabic later), then point every
-- existing synonym at its color. Safe on an empty table (no-ops). Runs before the
-- next migration sets color_id NOT NULL and drops canonical_family.
INSERT INTO "colors" ("name", "family")
	SELECT DISTINCT "canonical_family", "canonical_family"
	FROM "color_synonyms"
	WHERE "canonical_family" IS NOT NULL
	ON CONFLICT ("family") DO NOTHING;--> statement-breakpoint
UPDATE "color_synonyms" AS s
	SET "color_id" = c."id"
	FROM "colors" AS c
	WHERE c."family" = s."canonical_family";