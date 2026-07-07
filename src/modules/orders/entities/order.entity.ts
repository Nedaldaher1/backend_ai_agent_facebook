import { relations, sql } from 'drizzle-orm';
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { conversations } from '@/modules/conversations/entities/conversation.entity';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';
import { orderItems } from './order-item.entity';

/** COD order lifecycle. Enforced in zod; the column stays text. */
export const ORDER_STATUSES = [
  'draft',
  'confirmed',
  'fulfilled',
  'canceled',
] as const;

/**
 * Inbound channel the order was captured on. Set SERVER-SIDE from the request
 * channel (never from LLM input). Today the temp endpoint is messenger;
 * whatsapp is wired ahead of the integration.
 */
export const ORDER_SOURCES = ['messenger', 'whatsapp'] as const;

/**
 * Runtime table: written by the agent on COD order capture. Linked to the
 * conversation it came from; if that conversation is deleted the link is
 * nulled (the order record is kept).
 *
 * Money columns are numeric(10,3) JOD (string end-to-end; never float) and are
 * derived SERVER-SIDE from the catalog + delivery-fee config at capture time —
 * the LLM cannot set prices or totals. `subtotal`/`delivery_fee`/`total` are
 * snapshots: they do not change if the catalog price changes later.
 *
 * PII / TODO: `phone` (normalized) and `address` are personal data. Stored in
 * cleartext for now; an encryption-at-rest + retention decision is tracked
 * separately (do not block order capture on it).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Always set AT CAPTURE TIME, never derived from the conversation — the
    // conversation FK is nullable (SET NULL on delete), so it cannot carry the
    // tenant for orphaned orders.
    tenantId: tenantIdColumn(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    // Channel the order came in on (enum enforced in zod). Server-set.
    source: text('source').notNull().default('messenger'),
    // Canonical Jordanian mobile (+9627XXXXXXXX); normalized at capture time.
    phone: text('phone'),
    // Free-text delivery address — the whole destination as the customer gave it.
    // Required at capture; the column stays nullable for migration safety.
    address: text('address'),
    // Order-level fallback size applied to any item that has no explicit size.
    unifiedSize: text('unified_size'),
    // Money (JOD, numeric(10,3), string end-to-end). Server-derived snapshots.
    subtotal: numeric('subtotal', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    deliveryFee: numeric('delivery_fee', { precision: 10, scale: 3 })
      .notNull()
      .default('0'),
    total: numeric('total', { precision: 10, scale: 3 }).notNull().default('0'),
    currency: text('currency').notNull().default('JOD'),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('orders_conversation_id_idx').on(t.conversationId),
    index('orders_tenant_status_idx').on(t.tenantId, t.status),
    // The one-editable-cart invariant, enforced at the DB: at most one draft
    // per conversation (NULL conversation_ids don't collide). Concurrent
    // capture_order calls race find-then-create; this makes the race lose.
    uniqueIndex('orders_conversation_draft_uq')
      .on(t.conversationId)
      .where(sql`${t.status} = 'draft'`),
    tenantIsolationPolicy(),
  ],
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
  // `status`/`source` are `.notNull().default(...)`, so they are optional on
  // insert; overriding the column drops drizzle-zod's default handling, so
  // restore optionality to keep the insert schema in sync with the table.
  status: z.enum(ORDER_STATUSES).optional(),
  source: z.enum(ORDER_SOURCES).optional(),
});

export const selectOrderSchema = createSelectSchema(orders, {
  status: z.enum(ORDER_STATUSES),
  source: z.enum(ORDER_SOURCES),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
