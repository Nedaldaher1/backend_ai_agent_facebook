import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { adminUsers } from '@/modules/admin/entities/admin-user.entity';
import { orderItems } from '@/modules/orders/entities/order-item.entity';

/** Allowed stock states. Enforced in zod; the column stays free-form text. */
export const STOCK_STATUSES = ['in_stock', 'low', 'out'] as const;

/**
 * JOD prices use three decimals and are handled as strings end-to-end (Drizzle
 * returns numeric as a string); never do floating-point math on prices. The
 * matching zod field validates the decimal shape with this regex.
 */
export const PRICE_JOD_REGEX = /^\d+(\.\d{1,3})?$/;

/**
 * Control-plane table: written by the admin side, read by the agent.
 * Conventions (see drizzle-schema-architect): snake_case columns, uuid PKs,
 * JOD money as numeric(10,3), arrays for sizes/images/tags, jsonb for free-form
 * attributes, and is_published as the publish gate.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdBy: uuid('created_by').references(() => adminUsers.id),
    name: text('name').notNull(),
    description: text('description'),
    sku: text('sku'),
    // JOD uses three decimals. Drizzle returns numeric as a string — keep it a
    // string end-to-end; never do floating-point math on prices.
    priceJod: numeric('price_jod', { precision: 10, scale: 3 }).notNull(),
    colorFamily: text('color_family'),
    colorShade: text('color_shade'),
    sleeveType: text('sleeve_type'),
    fabric: text('fabric'),
    embellishment: text('embellishment'),
    occasion: text('occasion'),
    sizes: text('sizes').array(),
    stockStatus: text('stock_status').notNull().default('in_stock'),
    imageUrls: text('image_urls').array(),
    tags: text('tags').array(),
    attributes: jsonb('attributes'),
    isPublished: boolean('is_published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('products_color_family_idx').on(t.colorFamily),
    index('products_is_published_idx').on(t.isPublished),
    index('products_stock_status_idx').on(t.stockStatus),
    uniqueIndex('products_sku_idx').on(t.sku),
  ],
);

/**
 * products N—1 admin_users (creator) and 1—N order_items (line references).
 */
export const productsRelations = relations(products, ({ one, many }) => ({
  createdBy: one(adminUsers, {
    fields: [products.createdBy],
    references: [adminUsers.id],
  }),
  orderItems: many(orderItems),
}));

export const insertProductSchema = createInsertSchema(products, {
  priceJod: z.string().regex(PRICE_JOD_REGEX, 'Invalid JOD amount'),
  // `stock_status` is `.notNull().default('in_stock')`, so it is optional on
  // insert; overriding the column drops drizzle-zod's default handling, so
  // restore optionality to keep the insert schema in sync with the table.
  stockStatus: z.enum(STOCK_STATUSES).optional(),
});

export const selectProductSchema = createSelectSchema(products, {
  priceJod: z.string().regex(PRICE_JOD_REGEX, 'Invalid JOD amount'),
  stockStatus: z.enum(STOCK_STATUSES),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
