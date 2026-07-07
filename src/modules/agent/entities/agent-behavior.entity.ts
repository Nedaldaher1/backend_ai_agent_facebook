import { sql } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';

/**
 * Control-plane table: the agent's persona, tone, rules, and canned messages.
 * The admin edits this; the agent reads the tenant's active row to build its
 * system prompt. escalation_triggers is free-form jsonb (e.g. keywords/
 * conditions that hand off to a human). "One active persona" is PER TENANT,
 * enforced by the partial unique index below (setActive must scope its
 * deactivation UPDATE by tenant, never `WHERE id <> :id` alone).
 */
export const agentBehavior = pgTable(
  'agent_behavior',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    persona: text('persona'),
    tone: text('tone'),
    rules: text('rules'),
    greeting: text('greeting'),
    fallbackMessage: text('fallback_message'),
    escalationTriggers: jsonb('escalation_triggers'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // At most one active persona per tenant, enforced at the DB.
    uniqueIndex('agent_behavior_tenant_active_idx')
      .on(t.tenantId)
      .where(sql`${t.isActive}`),
    tenantIsolationPolicy(),
  ],
);

export const insertAgentBehaviorSchema = createInsertSchema(agentBehavior);
export const selectAgentBehaviorSchema = createSelectSchema(agentBehavior);

export type AgentBehavior = typeof agentBehavior.$inferSelect;
export type NewAgentBehavior = typeof agentBehavior.$inferInsert;
