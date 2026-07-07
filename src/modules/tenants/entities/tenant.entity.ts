import { sql } from 'drizzle-orm';
import {
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { plans } from './plan.entity';

/** Tenant lifecycle states. Enforced in zod; the column stays free-form text. */
export const TENANT_STATUSES = ['active', 'trial', 'suspended'] as const;

/**
 * Platform-plane table: one row per merchant/brand on the platform. The hub
 * every domain table hangs off via tenant_id. `settings` carries per-tenant
 * feature flags and knobs (e.g. telegramChatId, triage/transcription toggles)
 * with global env defaults as fallback.
 *
 * Not under RLS itself (it has no tenant_id): the webhook resolves page →
 * channel → tenant before any tenant context exists, and the super-admin realm
 * manages rows across tenants. Protected by realm auth, not policies.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('active'),
    planId: uuid('plan_id').references(() => plans.id),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('tenants_slug_idx').on(t.slug)],
);

/**
 * The tenant_id column every domain table carries.
 *
 * DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid is
 * deliberate: existing INSERT paths that do not name tenant_id pick up the
 * tenant bound to the current transaction by TenantDb (set_config with
 * is_local=true), and the RLS WITH CHECK then verifies it. With no tenant
 * bound the default evaluates to NULL and the NOT NULL constraint rejects the
 * write — fail-closed, loudly. The NULLIF matters: after a SET LOCAL
 * transaction ends, an otherwise-unset custom GUC reads back as the EMPTY
 * STRING (not NULL) on that session, and ''::uuid would turn every later
 * unbound query on that pooled connection into a 22P02 cast error.
 */
export const tenantIdColumn = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`)
    .references(() => tenants.id, { onDelete: 'cascade' });

/**
 * The single RLS policy attached to every domain table. USING gates reads,
 * WITH CHECK gates writes; NULLIF(current_setting(..., true), '') returns NULL
 * both when the GUC was never set AND when a finished SET LOCAL left it as an
 * empty string on the session, so the predicate matches zero rows — fail-
 * closed, never an error, never a leak. Table owners bypass it (migrations run
 * as the owner); the app connects as the non-owner app_runtime role, which is
 * bound.
 */
export const tenantIsolationPolicy = () =>
  pgPolicy('tenant_isolation', {
    for: 'all',
    using: sql`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    withCheck: sql`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
  });

export const insertTenantSchema = createInsertSchema(tenants, {
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'slug must be lowercase kebab-case starting with a letter',
    ),
  status: z.enum(TENANT_STATUSES).optional(),
});
export const selectTenantSchema = createSelectSchema(tenants, {
  status: z.enum(TENANT_STATUSES),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
