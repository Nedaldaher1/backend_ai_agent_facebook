import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

/**
 * Platform-plane table: subscription plans tenants are assigned to. Written by
 * the super-admin only; read by the quota guard. NULL limits mean unlimited
 * (the dev plan). `price_micro_usd` follows the money-as-integer rule
 * (micro-dollars) — never floating point.
 *
 * Not tenant-scoped and not under RLS: protected by the platform auth realm.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** NULL = unlimited. Customer turns per calendar month. */
    monthlyMessageLimit: integer('monthly_message_limit'),
    /** NULL = unlimited. Total LLM tokens (input+output) per calendar month. */
    monthlyTokenLimit: bigint('monthly_token_limit', { mode: 'number' }),
    priceMicroUsd: integer('price_micro_usd').notNull().default(0),
    features: jsonb('features').notNull().default({}),
  },
  (t) => [uniqueIndex('plans_name_idx').on(t.name)],
);

export const insertPlanSchema = createInsertSchema(plans);
export const selectPlanSchema = createSelectSchema(plans);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
