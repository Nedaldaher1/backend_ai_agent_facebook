import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

/**
 * Control-plane table: the agent's persona, tone, rules, and canned messages.
 * The admin edits this; the agent reads the active row to build its system
 * prompt. escalation_triggers is free-form jsonb (e.g. keywords/conditions
 * that hand off to a human).
 */
export const agentBehavior = pgTable('agent_behavior', {
  id: uuid('id').primaryKey().defaultRandom(),
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
});

export const insertAgentBehaviorSchema = createInsertSchema(agentBehavior);
export const selectAgentBehaviorSchema = createSelectSchema(agentBehavior);

export type AgentBehavior = typeof agentBehavior.$inferSelect;
export type NewAgentBehavior = typeof agentBehavior.$inferInsert;
