CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"attribute_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_slug_idx" ON "product_categories" USING btree ("slug");--> statement-breakpoint
-- Seed the "abaya" category so existing (abaya-only) products keep a home. Its
-- attribute schema reproduces the retired sleeve/fabric/occasion/embellishment
-- enums, now stored per-product under products.attributes.values.
INSERT INTO "product_categories" ("id", "name", "slug", "sort_order", "attribute_schema") VALUES (
	'11111111-0000-4000-8000-000000000001',
	'عباية',
	'abaya',
	0,
	'[
		{"key":"sleeve","label":"نوع الكم","type":"select","options":[
			{"value":"wide","label":"كم واسع"},
			{"value":"narrow","label":"كم ضيق"},
			{"value":"flared","label":"كم كلوش"},
			{"value":"regular","label":"كم عادي"},
			{"value":"sleeveless","label":"بدون كم"}
		]},
		{"key":"fabric","label":"القماش","type":"select","options":[
			{"value":"crepe","label":"كريب"},
			{"value":"naqda","label":"نقدة"},
			{"value":"georgette","label":"جورجيت"},
			{"value":"velvet","label":"مخمل"},
			{"value":"cotton","label":"قطن"},
			{"value":"rayon","label":"حرير صناعي"}
		]},
		{"key":"occasion","label":"المناسبة","type":"select","options":[
			{"value":"daily","label":"يومي"},
			{"value":"events","label":"مناسبات"},
			{"value":"soiree","label":"سواريه"},
			{"value":"prayer","label":"صلاة"},
			{"value":"work","label":"عمل"}
		]},
		{"key":"embroidery","label":"التطريز / الزينة","type":"select","options":[
			{"value":"none","label":"بدون"},
			{"value":"light","label":"تطريز خفيف"},
			{"value":"heavy","label":"تطريز كثيف"},
			{"value":"stones","label":"حجر / سواروفسكي"},
			{"value":"tassels","label":"شراشيب"},
			{"value":"lace","label":"دانتيل"}
		]}
	]'::jsonb
) ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- Convert the plain text[] size codes into structured jsonb sizes. Postgres
-- forbids a subquery in an ALTER COLUMN ... USING transform, so migrate via a
-- temp column: known abaya numeric codes carry the historical SIZE_CATALOG
-- weight bands; unknown codes (e.g. "XL") become a bare label.
ALTER TABLE "products" ADD COLUMN "sizes_jsonb" jsonb;--> statement-breakpoint
UPDATE "products" SET "sizes_jsonb" = (
	SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
		'label', s,
		'minWeightKg', (CASE s WHEN '1' THEN 60 WHEN '2' THEN 90 WHEN '3' THEN 120 WHEN '4' THEN 150 END),
		'maxWeightKg', (CASE s WHEN '1' THEN 90 WHEN '2' THEN 120 WHEN '3' THEN 150 WHEN '4' THEN 180 END)
	)))
	FROM unnest("sizes") AS s
) WHERE "sizes" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "sizes";--> statement-breakpoint
ALTER TABLE "products" RENAME COLUMN "sizes_jsonb" TO "sizes";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
-- Existing products are all abayas: point them at the seeded category and lift
-- their legacy attribute columns into attributes.values (dropped in 0018).
UPDATE "products" SET "category_id" = '11111111-0000-4000-8000-000000000001' WHERE "category_id" IS NULL;--> statement-breakpoint
UPDATE "products" SET "attributes" =
	COALESCE("attributes", '{}'::jsonb) ||
	jsonb_build_object('values', jsonb_strip_nulls(jsonb_build_object(
		'sleeve', "sleeve_type",
		'fabric', "fabric",
		'occasion', "occasion",
		'embroidery', "embellishment"
	)));
