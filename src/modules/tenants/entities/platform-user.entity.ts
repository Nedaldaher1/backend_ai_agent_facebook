import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

/** Platform operator roles. Enforced in zod; the column stays free-form text. */
export const PLATFORM_ROLES = ['super_admin', 'support'] as const;

/**
 * Platform-plane table: the platform operators (us), a SEPARATE auth realm from
 * merchant staff (admin_users). Signed with PLATFORM_JWT_SECRET, never with the
 * tenant JWT_SECRET — a merchant token must never verify as a platform token or
 * vice versa. Not tenant-scoped, not under RLS.
 */
export const platformUsers = pgTable(
  'platform_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('super_admin'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('platform_users_email_idx').on(t.email)],
);

export const insertPlatformUserSchema = createInsertSchema(platformUsers, {
  email: z.email(),
  role: z.enum(PLATFORM_ROLES).optional(),
});
export const selectPlatformUserSchema = createSelectSchema(platformUsers, {
  email: z.email(),
  role: z.enum(PLATFORM_ROLES),
});

export type PlatformUser = typeof platformUsers.$inferSelect;
export type NewPlatformUser = typeof platformUsers.$inferInsert;
