import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Control-plane table: written by the admin side, read by the agent.
 * Conventions (see drizzle-schema-architect): snake_case columns, uuid PKs,
 * JOD money as numeric(10,3), arrays for sizes/images, jsonb for free-form
 * attributes, and is_published as the publish gate.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    colorFamily: text('color_family'),
    sizes: text('sizes').array(),
    fabric: text('fabric'),
    occasion: text('occasion'),
    // JOD uses three decimals. Drizzle returns numeric as a string — keep it a
    // string end-to-end; never do floating-point math on prices.
    priceJod: numeric('price_jod', { precision: 10, scale: 3 }).notNull(),
    imageUrls: text('image_urls').array(),
    attributes: jsonb('attributes'),
    stockStatus: text('stock_status').notNull().default('in_stock'),
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
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
