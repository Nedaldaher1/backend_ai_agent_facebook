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
import { productCategories } from './product-category.entity';

/** Allowed stock states. Enforced in zod; the column stays free-form text. */
export const STOCK_STATUSES = ['in_stock', 'low', 'out'] as const;

/**
 * One admin-defined size on a product. The catalog is no longer abaya-only with
 * a single brand-wide weight chart: each product names its own sizes and (for
 * weight-based sizing) gives each a kg range. `label` is free — a number ("1")
 * or a letter ("L") — so numbered+weight and letter sizes can coexist on one
 * product. The weight range is OPTIONAL: letter-only sizes omit it, and the
 * agent then asks the customer to pick a letter instead of inferring from weight.
 */
export const productSizeSchema = z
  .object({
    label: z.string().trim().min(1),
    minWeightKg: z.number().int().positive().optional(),
    maxWeightKg: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      s.minWeightKg != null &&
      s.maxWeightKg != null &&
      s.minWeightKg > s.maxWeightKg
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minWeightKg must be ≤ maxWeightKg',
        path: ['minWeightKg'],
      });
    }
  });
export type ProductSize = z.infer<typeof productSizeSchema>;

/** A product's size list — labels must be unique so an order line is unambiguous. */
export const productSizesSchema = z
  .array(productSizeSchema)
  .superRefine((sizes, ctx) => {
    const seen = new Set<string>();
    for (const s of sizes) {
      const key = s.label.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate size label "${s.label}"`,
        });
      }
      seen.add(key);
    }
  });

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
    // The clothing category (abaya, pajama, …). It owns the attribute schema
    // whose values this product fills in under `attributes.values`.
    categoryId: uuid('category_id').references(() => productCategories.id),
    name: text('name').notNull(),
    description: text('description'),
    sku: text('sku'),
    // JOD uses three decimals. Drizzle returns numeric as a string — keep it a
    // string end-to-end; never do floating-point math on prices.
    priceJod: numeric('price_jod', { precision: 10, scale: 3 }).notNull(),
    colorFamily: text('color_family'),
    colorShade: text('color_shade'),
    // Per-product structured sizes (label + optional kg range). Category-specific
    // attributes (formerly the fixed sleeve/fabric/occasion/embellishment
    // columns) now live in `attributes.values`, keyed by the category's schema.
    sizes: jsonb('sizes').$type<ProductSize[]>(),
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
    index('products_category_id_idx').on(t.categoryId),
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
  category: one(productCategories, {
    fields: [products.categoryId],
    references: [productCategories.id],
  }),
  orderItems: many(orderItems),
}));

export const insertProductSchema = createInsertSchema(products, {
  priceJod: z.string().regex(PRICE_JOD_REGEX, 'Invalid JOD amount'),
  categoryId: z.uuid().nullable().optional(),
  // Structured per-product sizes; drizzle-zod would infer the jsonb column as
  // unknown, so pin it to the validated size list (labels unique, kg ranges
  // ordered). Nullable/optional to match the column.
  sizes: productSizesSchema.nullable().optional(),
  // `stock_status` is `.notNull().default('in_stock')`, so it is optional on
  // insert; overriding the column drops drizzle-zod's default handling, so
  // restore optionality to keep the insert schema in sync with the table.
  stockStatus: z.enum(STOCK_STATUSES).optional(),
});

export const selectProductSchema = createSelectSchema(products, {
  priceJod: z.string().regex(PRICE_JOD_REGEX, 'Invalid JOD amount'),
  sizes: productSizesSchema.nullable(),
  stockStatus: z.enum(STOCK_STATUSES),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
