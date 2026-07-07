import { relations } from 'drizzle-orm';
import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';
import { products } from './product.entity';

/**
 * Per-image, admin-authored description. ONE row per (product, image storage
 * key): the image is identified by the product plus the storage key it already
 * has in products.image_urls — no separate image entity is introduced (Option A,
 * mirroring product_image_colors), so existing upload/list/primary flows stay
 * untouched. The service validates the storage_key belongs to the product before
 * writing.
 *
 * The description is embedded TOGETHER with the image (one multimodal vector via
 * gemini-embedding-2) so visual search matches on both the picture and the words
 * the admin wrote about it. The composite PK (product_id, storage_key) keeps it
 * strictly one description per image.
 */
export const productImageDescriptions = pgTable(
  'product_image_descriptions',
  {
    tenantId: tenantIdColumn(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    description: text('description').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.storageKey] }),
    tenantIsolationPolicy(),
  ],
);

/** productImageDescriptions N—1 products. */
export const productImageDescriptionsRelations = relations(
  productImageDescriptions,
  ({ one }) => ({
    product: one(products, {
      fields: [productImageDescriptions.productId],
      references: [products.id],
    }),
  }),
);

export const insertProductImageDescriptionSchema = createInsertSchema(
  productImageDescriptions,
);
export const selectProductImageDescriptionSchema = createSelectSchema(
  productImageDescriptions,
);

export type ProductImageDescription =
  typeof productImageDescriptions.$inferSelect;
export type NewProductImageDescription =
  typeof productImageDescriptions.$inferInsert;
