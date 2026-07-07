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
import { tenants } from './tenant.entity';

export const CHANNEL_TYPES = ['messenger', 'whatsapp', 'instagram'] as const;
export const CHANNEL_STATUSES = [
  'connected',
  'paused',
  'disconnected',
] as const;

/**
 * Platform-plane table: a connected Facebook page (or, later, WhatsApp/IG
 * account). `page_id` is GLOBALLY unique — it is the webhook routing key:
 * entry[].id → channel → tenant. The page access token is stored encrypted at
 * rest (AES-256-GCM, `v1:<iv>:<tag>:<ct>`, key from CHANNEL_TOKEN_ENC_KEY) and
 * must never appear in logs or API responses.
 *
 * Deliberately NOT under RLS: the webhook must resolve page_id → tenant BEFORE
 * any tenant context exists. Tenant-admin reads of "my channels" are scoped in
 * code; writes are super-admin only.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('messenger'),
    pageId: text('page_id').notNull(),
    pageAccessTokenEncrypted: text('page_access_token_encrypted').notNull(),
    status: text('status').notNull().default('connected'),
    connectedAt: timestamp('connected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => [
    uniqueIndex('channels_page_id_idx').on(t.pageId),
    index('channels_tenant_id_idx').on(t.tenantId),
  ],
);

export const insertChannelSchema = createInsertSchema(channels, {
  type: z.enum(CHANNEL_TYPES).optional(),
  status: z.enum(CHANNEL_STATUSES).optional(),
});
export const selectChannelSchema = createSelectSchema(channels, {
  type: z.enum(CHANNEL_TYPES),
  status: z.enum(CHANNEL_STATUSES),
});

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
