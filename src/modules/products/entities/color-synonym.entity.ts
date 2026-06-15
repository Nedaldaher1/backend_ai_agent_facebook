import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

/**
 * Maps dialect color terms to a canonical color family so search can normalize
 * customer language — e.g. "نبيتي" -> "أحمر" (red). Written by the admin side.
 */
export const colorSynonyms = pgTable(
  'color_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    term: text('term').notNull(),
    canonicalFamily: text('canonical_family').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('color_synonyms_term_idx').on(t.term)],
);

export const insertColorSynonymSchema = createInsertSchema(colorSynonyms);
export const selectColorSynonymSchema = createSelectSchema(colorSynonyms);

export type ColorSynonym = typeof colorSynonyms.$inferSelect;
export type NewColorSynonym = typeof colorSynonyms.$inferInsert;
