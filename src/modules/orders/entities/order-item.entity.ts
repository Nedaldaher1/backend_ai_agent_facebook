import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { products } from '@/modules/products/entities/product.entity';
import { orders } from './order.entity';

/**
 * Runtime table: line items of a COD order. Deleting an order cascades to its
 * items. product_id references the catalog (schema-as-contract FK).
 *
 * Each item is one model/image variant the customer chose: `product_id` plus the
 * `storage_key` of the exact image (which identifies the model's colour via
 * product_image_colors). `unit_price`/`line_total` are SNAPSHOTS of the catalog
 * price at order time — an order must not change if the catalog price changes
 * later. `product_name`/`color_name` are display snapshots for clean receipts.
 *
 * `storage_key` is REQUIRED — each line is identified by the chosen image (and
 * that image's colour via product_image_colors). The display snapshots
 * (`product_name`/`color_name`) are populated SERVER-SIDE by the capture flow and
 * stay nullable so the admin/manual item path remains backward-compatible.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id),
    // The chosen product image (a key in products.image_urls) — pins the exact
    // model + colour variant the customer picked. Required: every line is
    // identified by its image (its colour comes via product_image_colors).
    storageKey: text('storage_key').notNull(),
    size: text('size'),
    qty: integer('qty').notNull().default(1),
    // Catalog price snapshot (JOD numeric(10,3), string end-to-end) and the
    // computed line total (unit_price × qty). Server-derived, never LLM-set.
    unitPrice: numeric('unit_price', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    lineTotal: numeric('line_total', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    // Display snapshots for order history / receipts.
    productName: text('product_name'),
    colorName: text('color_name'),
  },
  (t) => [
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_product_id_idx').on(t.productId),
  ],
);

/** order_items N—1 orders and N—1 products. */
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export const insertOrderItemSchema = createInsertSchema(orderItems);
export const selectOrderItemSchema = createSelectSchema(orderItems);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
