import { relations, sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { conversations } from './conversation.entity';

/** Who authored a message. Enforced in zod; the column stays text. */
export const MESSAGE_ROLES = ['customer', 'agent'] as const;

/**
 * Runtime table: written by the agent. One row per message in a conversation.
 * `image_url` carries a customer-sent image; `attributes` holds anything
 * extracted from it (e.g. vision results). Deleting a conversation cascades.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content'),
    imageUrl: text('image_url'),
    attributes: jsonb('attributes'),
    // Idempotency key for an inbound customer turn: the provider message id
    // (ManyChat) or a content+time-window hash. Nullable so legacy rows and
    // non-deduped writes are unaffected.
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('messages_conversation_id_idx').on(t.conversationId),
    // Idempotency: at most one row per (conversation, external_id). Partial
    // (external_id IS NOT NULL) so rows without a key never collide.
    uniqueIndex('messages_conversation_external_id_uq')
      .on(t.conversationId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  ],
);

/** messages N—1 conversations. */
export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const insertMessageSchema = createInsertSchema(messages, {
  role: z.enum(MESSAGE_ROLES),
});

export const selectMessageSchema = createSelectSchema(messages, {
  role: z.enum(MESSAGE_ROLES),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
