import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { products } from './product.entity';

/**
 * Control-plane table: maps a stable Facebook ad reference slug to the
 * product(s) featured in that ad. Written by the admin side; the agent only
 * reads it to surface the right products when a customer arrives from a known
 * ad. Only active rows (is_active = true) are considered by the agent.
 */
export const adProductLinks = pgTable(
  'ad_product_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adRef: text('ad_ref').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    campaign: text('campaign'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Prevents the same product from being linked to the same ad ref twice.
    uniqueIndex('ad_product_links_ad_ref_product_id_idx').on(
      t.adRef,
      t.productId,
    ),
    // Partial index: agent lookup of active links by ad_ref — filters to
    // is_active = true rows only, keeping the index small and selective.
    index('ad_product_links_ad_ref_active_idx')
      .on(t.adRef)
      .where(sql`${t.isActive}`),
    // FK index: speeds up cascading deletes and joins from the products side.
    index('ad_product_links_product_id_idx').on(t.productId),
  ],
);

/**
 * adProductLinks N—1 products: each link belongs to exactly one product.
 */
export const adProductLinksRelations = relations(
  adProductLinks,
  ({ one }) => ({
    product: one(products, {
      fields: [adProductLinks.productId],
      references: [products.id],
    }),
  }),
);

export const insertAdProductLinkSchema = createInsertSchema(adProductLinks);
export const selectAdProductLinkSchema = createSelectSchema(adProductLinks);

export type AdProductLink = typeof adProductLinks.$inferSelect;
export type NewAdProductLink = typeof adProductLinks.$inferInsert;
