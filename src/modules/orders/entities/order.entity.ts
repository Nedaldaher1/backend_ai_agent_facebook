import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { conversations } from '@/modules/conversations/entities/conversation.entity';
import { orderItems } from './order-item.entity';

/** COD order lifecycle. Enforced in zod; the column stays text. */
export const ORDER_STATUSES = [
  'draft',
  'confirmed',
  'fulfilled',
  'canceled',
] as const;

/**
 * Runtime table: written by the agent on COD order capture. Linked to the
 * conversation it came from; if that conversation is deleted the link is
 * nulled (the order record is kept).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    customerName: text('customer_name'),
    phone: text('phone'),
    address: text('address'),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('orders_conversation_id_idx').on(t.conversationId)],
);

/** orders N—1 conversations and 1—N order_items. */
export const ordersRelations = relations(orders, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [orders.conversationId],
    references: [conversations.id],
  }),
  items: many(orderItems),
}));

export const insertOrderSchema = createInsertSchema(orders, {
  // `status` is `.notNull().default('draft')`, so it is optional on insert;
  // overriding the column drops drizzle-zod's default handling, so restore
  // optionality to keep the insert schema in sync with the table.
  status: z.enum(ORDER_STATUSES).optional(),
});

export const selectOrderSchema = createSelectSchema(orders, {
  status: z.enum(ORDER_STATUSES),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
