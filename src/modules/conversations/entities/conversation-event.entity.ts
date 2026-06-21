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
import { conversations } from './conversation.entity';

/** All event kinds recorded in the audit trail. */
export const CONVERSATION_EVENT_TYPES = [
  'pause',
  'resume',
  'assign',
  'handoff',
  'human_message',
  'ai_state_change',
] as const;

/** Who (or what) produced the event. */
export const CONVERSATION_ACTOR_TYPES = ['admin', 'agent', 'system'] as const;

/**
 * Audit table: immutable append-only log of every state transition on a
 * conversation. Written by the agent, the admin API, and the handoff
 * machinery. Deleting a conversation cascades all its events.
 */
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    // Null when the actor is the agent or a system process.
    actor: text('actor'),
    actorType: text('actor_type').notNull().default('admin'),
    fromState: text('from_state'),
    toState: text('to_state'),
    reason: text('reason'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversation_events_conversation_id_idx').on(t.conversationId),
  ],
);

/** conversationEvents N—1 conversations. */
export const conversationEventsRelations = relations(
  conversationEvents,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationEvents.conversationId],
      references: [conversations.id],
    }),
  }),
);

export const insertConversationEventSchema = createInsertSchema(
  conversationEvents,
  {
    type: z.enum(CONVERSATION_EVENT_TYPES),
    actorType: z.enum(CONVERSATION_ACTOR_TYPES),
  },
);

export const selectConversationEventSchema = createSelectSchema(
  conversationEvents,
  {
    type: z.enum(CONVERSATION_EVENT_TYPES),
    actorType: z.enum(CONVERSATION_ACTOR_TYPES),
  },
);

export type ConversationEvent = typeof conversationEvents.$inferSelect;
export type NewConversationEvent = typeof conversationEvents.$inferInsert;
