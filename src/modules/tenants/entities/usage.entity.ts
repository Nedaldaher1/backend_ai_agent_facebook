import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { tenants } from './tenant.entity';

/** Every metered LLM/embedding operation kind. */
export const USAGE_OPERATIONS = [
  'agent',
  'vision',
  'transcription',
  'triage',
  'embedding',
] as const;

/**
 * Platform-plane table: raw usage ledger — one row per LLM/embedding call,
 * written asynchronously (queue) so metering never sits in the reply path.
 * `conversation_id` is a plain uuid with NO FK: billing data must survive
 * conversation deletion. `cost_micro_usd` is an integer (micro-dollars) —
 * money-as-integer, never float.
 *
 * Not under RLS in the MVP: written by the platform runtime, read by the
 * super-admin dashboards only (realm-guarded). Tenant-facing usage pages are
 * post-MVP and will revisit this.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    operation: text('operation').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    costMicroUsd: integer('cost_micro_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('usage_events_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

/**
 * Rollup of usage_events per (tenant, day, operation, model), maintained by the
 * worker's periodic aggregation job (idempotent re-aggregation). Source for the
 * super-admin token/cost dashboards.
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    operation: text('operation').notNull(),
    model: text('model').notNull(),
    sumInput: bigint('sum_input', { mode: 'number' }).notNull().default(0),
    sumOutput: bigint('sum_output', { mode: 'number' }).notNull().default(0),
    sumCached: bigint('sum_cached', { mode: 'number' }).notNull().default(0),
    sumCostMicro: bigint('sum_cost_micro', { mode: 'number' })
      .notNull()
      .default(0),
    messageCount: integer('message_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.operation, t.model] }),
  ],
);

export const insertUsageEventSchema = createInsertSchema(usageEvents, {
  operation: z.enum(USAGE_OPERATIONS),
});
export const selectUsageEventSchema = createSelectSchema(usageEvents, {
  operation: z.enum(USAGE_OPERATIONS),
});

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type UsageDaily = typeof usageDaily.$inferSelect;
