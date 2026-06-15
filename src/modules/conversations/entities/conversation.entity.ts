import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { messages } from './message.entity';
import { orders } from '@/modules/orders/entities/order.entity';

/**
 * Runtime table: written by the agent. One row per customer thread, keyed by
 * the page-scoped id (psid). `state` is free-form jsonb (preferences + the
 * current funnel stage); `ad_ref` records the source ad the customer came from.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    psid: text('psid').notNull(),
    threadId: text('thread_id'),
    adRef: text('ad_ref'),
    state: jsonb('state'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('conversations_psid_idx').on(t.psid)],
);

/** conversations 1—N messages and 1—N orders. */
export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
  orders: many(orders),
}));

export const insertConversationSchema = createInsertSchema(conversations);
export const selectConversationSchema = createSelectSchema(conversations);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
