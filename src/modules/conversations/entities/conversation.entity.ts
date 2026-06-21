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
import { z } from 'zod';
import { messages } from './message.entity';
import { conversationEvents } from './conversation-event.entity';
import { orders } from '@/modules/orders/entities/order.entity';

/** Possible values for the ai_state column. */
export const AI_STATES = ['bot', 'human', 'paused'] as const;

/**
 * Runtime table: written by the agent. One row per customer thread, keyed by
 * the page-scoped id (psid). `state` is free-form jsonb (preferences + the
 * current funnel stage); `ad_ref` records the source ad the customer came from.
 * `ai_state` is the dedicated, indexed handler-state column that drives the
 * secondary gate and the admin handoff API.
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
    // Handler-state columns (WS1 — AIA-34)
    aiState: text('ai_state').notNull().default('bot'),
    assignedTo: text('assigned_to'),
    handoffReason: text('handoff_reason'),
    humanSummary: text('human_summary'),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    aiStateUpdatedAt: timestamp('ai_state_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_psid_idx').on(t.psid),
    index('conversations_ai_state_idx').on(t.aiState),
  ],
);

/** conversations 1—N messages, 1—N orders, 1—N conversationEvents. */
export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
  orders: many(orders),
  conversationEvents: many(conversationEvents),
}));

export const insertConversationSchema = createInsertSchema(conversations, {
  // DB default is 'bot'; keep the field optional so callers need not supply it,
  // but constrain the value to the known enum when it is supplied.
  aiState: z.enum(AI_STATES).optional(),
});
export const selectConversationSchema = createSelectSchema(conversations, {
  aiState: z.enum(AI_STATES),
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
