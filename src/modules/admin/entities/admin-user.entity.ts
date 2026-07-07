import { relations } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { products } from '@/modules/products/entities/product.entity';
import { knowledgeEntries } from '@/modules/knowledge/entities/knowledge-entry.entity';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';

/** Allowed admin roles. Enforced in zod; the column itself stays free-form text. */
export const ADMIN_ROLES = ['admin', 'editor'] as const;

/**
 * Control-plane table: the merchant-staff accounts that write the catalog and
 * knowledge base. The agent never writes here. Email stays GLOBALLY unique in
 * the MVP (staff are provisioned per tenant; login resolves by email alone) —
 * per-tenant email uniqueness is a documented post-MVP relaxation.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    email: text('email').notNull(),
    name: text('name'),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('admin'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_users_email_idx').on(t.email),
    tenantIsolationPolicy(),
  ],
);

/**
 * admin_users 1—N products and 1—N knowledge_entries via created_by.
 * Co-located here per the schema-as-contract convention.
 */
export const adminUsersRelations = relations(adminUsers, ({ many }) => ({
  products: many(products),
  knowledgeEntries: many(knowledgeEntries),
}));

export const insertAdminUserSchema = createInsertSchema(adminUsers, {
  email: z.email(),
  // `role` is `.notNull().default('admin')` in the table, so it is optional on
  // insert; overriding the column with z.enum drops drizzle-zod's default
  // handling, so restore optionality to keep the schema in sync with the table.
  role: z.enum(ADMIN_ROLES).optional(),
});

export const selectAdminUserSchema = createSelectSchema(adminUsers, {
  email: z.email(),
  role: z.enum(ADMIN_ROLES),
});

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
