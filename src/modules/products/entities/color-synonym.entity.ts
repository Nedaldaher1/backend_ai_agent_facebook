import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Maps dialect color terms to a canonical color family so search can normalize
 * customer language — e.g. "نبيتي" -> "red". Written by the admin side.
 */
export const colorSynonyms = pgTable(
  'color_synonyms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    term: text('term').notNull(),
    colorFamily: text('color_family').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('color_synonyms_term_idx').on(t.term)],
);

export type ColorSynonym = typeof colorSynonyms.$inferSelect;
