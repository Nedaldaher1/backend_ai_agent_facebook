import { relations } from 'drizzle-orm';
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

/** Allowed knowledge categories. Enforced in zod; the column stays text. */
export const KNOWLEDGE_CATEGORIES = ['faq', 'policy', 'shipping'] as const;

/**
 * Control-plane table: brand knowledge / FAQ / policies the agent retrieves for
 * context. Written by the admin side; agent reads must honor is_published.
 */
export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdBy: uuid('created_by').references(() => adminUsers.id),
    category: text('category').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags').array(),
    priority: integer('priority').notNull().default(0),
    isPublished: boolean('is_published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('knowledge_entries_category_idx').on(t.category),
    index('knowledge_entries_is_published_idx').on(t.isPublished),
  ],
);

/** knowledge_entries N—1 admin_users (creator). */
export const knowledgeEntriesRelations = relations(
  knowledgeEntries,
  ({ one }) => ({
    createdBy: one(adminUsers, {
      fields: [knowledgeEntries.createdBy],
      references: [adminUsers.id],
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
