import { relations } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { colors } from './color.entity';
import { products } from './product.entity';

/**
 * Join table tagging a single product image with one or more canonical colors
 * (image N—N colors). The image is identified by the product plus the storage
 * key it already has in products.image_urls — no separate image entity is
 * introduced (Option A), so this keeps the existing upload/list/primary flows
 * untouched. The service validates that storage_key actually belongs to the
 * product before inserting.
 *
 * The FK to `colors` (ON DELETE RESTRICT) is what enforces the rule that an
 * admin can only attach a managed color to an image, and that a color still used
 * by an image cannot be deleted. The composite PK both forbids tagging the same
 * color twice on one image and allows multiple colors per image.
 */
export const productImageColors = pgTable(
  'product_image_colors',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    colorId: uuid('color_id')
      .notNull()
      .references(() => colors.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.storageKey, t.colorId] }),
    // FK index: speeds up "is this color in use?" checks before a color delete.
    index('product_image_colors_color_id_idx').on(t.colorId),
  ],
);

/**
 * productImageColors N—1 products and N—1 colors.
 */
export const productImageColorsRelations = relations(
  productImageColors,
  ({ one }) => ({
    product: one(products, {
      fields: [productImageColors.productId],
      references: [products.id],
    }),
    color: one(colors, {
      fields: [productImageColors.colorId],
      references: [colors.id],
    }),
  }),
);

export const insertProductImageColorSchema =
  createInsertSchema(productImageColors);
export const selectProductImageColorSchema =
  createSelectSchema(productImageColors);

export type ProductImageColor = typeof productImageColors.$inferSelect;
export type NewProductImageColor = typeof productImageColors.$inferInsert;
