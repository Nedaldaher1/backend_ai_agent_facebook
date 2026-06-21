import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Control-plane table: weight band → abaya size mapping, editable by admins.
 *
 * Selection logic (enforced in the service, NOT here):
 *   greatest min_weight ≤ customer weight wins (lower-bound lookup).
 *   A ceiling check is the service's responsibility — rows above the ceiling
 *   are filtered out before picking the max.
 *
 * `min_weight` is UNIQUE so each threshold maps to exactly one size and seed
 * INSERTs are idempotent via ON CONFLICT (min_weight) DO NOTHING.
 */
export const sizeChart = pgTable('size_chart', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Lower weight bound (kg) for this size band. Unique: one row per threshold.
  minWeight: integer('min_weight').notNull().unique(),
  // Abaya size code (e.g. '1', '2', '3', 'XL').
  size: text('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SizeChartRow = typeof sizeChart.$inferSelect;
export type NewSizeChartRow = typeof sizeChart.$inferInsert;
