ALTER TABLE "colors" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Seed the reserved "unassigned" system color that product-image tags fall back
-- to when their assigned color is deleted. Idempotent: keyed on the unique
-- `family`, so re-running this migration (or a re-seed) is a no-op and never
-- creates a duplicate. Resolve the row at runtime by family ('__unassigned__');
-- never hardcode its uuid (gen_random_uuid() fills the id here).
INSERT INTO "colors" ("name", "family", "hex", "is_active", "is_system")
	VALUES ('غير معرف', '__unassigned__', NULL, false, true)
	ON CONFLICT ("family") DO NOTHING;