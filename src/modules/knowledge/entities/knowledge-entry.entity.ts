import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { adminUsers } from '@/modules/admin/entities/admin-user.entity';
import { products } from '@/modules/products/entities/product.entity';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';

/** Allowed knowledge categories. Enforced in zod; the column stays text. */
export const KNOWLEDGE_CATEGORIES = [
  'faq',
  'policy',
  'shipping',
  'returns',
  'sizing',
  'payment',
  'care',
  'canned_response',
  'product_info',
  'general',
] as const;

/**
 * Control-plane table: brand knowledge / FAQ / policies the agent retrieves for
 * context. Written by the admin side; agent reads must honor is_published.
 */
export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    createdBy: uuid('created_by').references(() => adminUsers.id),
    category: text('category').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags').array(),
    priority: integer('priority').notNull().default(0),
    isPublished: boolean('is_published').notNull().default(false),
    /** NULL = global knowledge; set = product-specific (one product → many entries). */
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'cascade',
    }),
    /** The case/question this entry answers, e.g. "هل القماش شفاف؟". Used for matching. */
    situation: text('situation'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('knowledge_entries_category_idx').on(t.category),
    // The agent's RAG read path filters (tenant, published) together.
    index('knowledge_entries_tenant_published_idx').on(
      t.tenantId,
      t.isPublished,
    ),
    index('knowledge_entries_product_id_idx')
      .on(t.productId)
      .where(sql`${t.isPublished}`),
    index('knowledge_entries_search_trgm_idx').using(
      'gin',
      sql`(coalesce(${t.title}, '') || ' ' || coalesce(${t.situation}, '') || ' ' || coalesce(${t.content}, '')) gin_trgm_ops`,
    ),
    tenantIsolationPolicy(),
  ],
);

/** knowledge_entries N—1 admin_users (creator); N—1 products (optional, for product-specific entries). */
export const knowledgeEntriesRelations = relations(
  knowledgeEntries,
  ({ one }) => ({
    createdBy: one(adminUsers, {
      fields: [knowledgeEntries.createdBy],
      references: [adminUsers.id],
    }),
    product: one(products, {
      fields: [knowledgeEntries.productId],
      references: [products.id],
    }),
  }),
);

export const insertKnowledgeEntrySchema = createInsertSchema(knowledgeEntries, {
  category: z.enum(KNOWLEDGE_CATEGORIES),
});

export const selectKnowledgeEntrySchema = createSelectSchema(knowledgeEntries, {
  category: z.enum(KNOWLEDGE_CATEGORIES),
});

export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type NewKnowledgeEntry = typeof knowledgeEntries.$inferInsert;
