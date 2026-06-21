CREATE TABLE "size_chart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_weight" integer NOT NULL,
	"size" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "size_chart_min_weight_unique" UNIQUE("min_weight")
);
--> statement-breakpoint
INSERT INTO "size_chart" ("min_weight", "size") VALUES (60, '1'), (90, '2') ON CONFLICT ("min_weight") DO NOTHING;
