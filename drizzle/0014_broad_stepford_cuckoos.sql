CREATE TABLE "product_image_descriptions" (
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "product_image_descriptions_product_id_storage_key_pk" PRIMARY KEY("product_id","storage_key")
);
--> statement-breakpoint
ALTER TABLE "product_image_descriptions" ADD CONSTRAINT "product_image_descriptions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;