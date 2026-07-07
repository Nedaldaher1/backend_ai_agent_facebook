import { relations } from 'drizzle-orm';
import {
  index,
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
import { colors } from './color.entity';

/**
 * Maps a dialect color term to a canonical color (color_synonyms N—1 colors), so
 * search can normalize customer language — e.g. "نبيتي" -> the "red" color. A
 * single color owns many terms; `term` is globally unique (one term resolves to
 * exactly one color). Written by the admin side, read by the agent.
 */
export const colorSynonyms = pgTable(
  'color_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    term: text('term').notNull(),
    colorId: uuid('color_id')
      .notNull()
      .references(() => colors.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One resolution per term WITHIN a tenant — different merchants may map the
    // same dialect word to different colors.
    uniqueIndex('color_synonyms_tenant_term_idx').on(t.tenantId, t.term),
    // FK index: speeds up "all terms of this color" lookups and cascading deletes.
    index('color_synonyms_color_id_idx').on(t.colorId),
    tenantIsolationPolicy(),
  ],
);

/**
 * colorSynonyms N—1 colors: each term belongs to exactly one canonical color.
 */
export const colorSynonymsRelations = relations(colorSynonyms, ({ one }) => ({
  color: one(colors, {
    fields: [colorSynonyms.colorId],
    references: [colors.id],
  }),
}));

export const insertColorSynonymSchema = createInsertSchema(colorSynonyms);
export const selectColorSynonymSchema = createSelectSchema(colorSynonyms);

export type ColorSynonym = typeof colorSynonyms.$inferSelect;
export type NewColorSynonym = typeof colorSynonyms.$inferInsert;
