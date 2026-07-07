import {
  boolean,
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
 * Control-plane table: the canonical color as a first-class entity, written by
 * the admin side and read by the agent's search path. A color owns many dialect
 * terms (see color_synonyms.color_id) and is what product images are tagged with
 * (see product_image_colors.color_id) — so the admin can only ever attach a
 * managed color to an image, never free-form text.
 *
 * `family` is the stable, canonical search key (e.g. "red") that
 * color_synonyms resolve to and that products.color_family is compared against;
 * `name` is the human label shown in the admin UI (e.g. "أحمر"); `hex` is an
 * optional swatch color for the UI.
 *
 * Kept deliberately import-free of its child tables (color_synonyms,
 * product_image_colors): the children reference `colors` one-way (like
 * ad_product_links → products), which avoids an entity import cycle. The
 * repositories use explicit joins, so no drizzle relational metadata is needed
 * here.
 */
export const colors = pgTable(
  'colors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    name: text('name').notNull(),
    family: text('family').notNull(),
    hex: text('hex'),
    isActive: boolean('is_active').notNull().default(true),
    // Marks reserved system colors (e.g. the "__unassigned__" sentinel that
    // image tags fall back to when their real color is deleted). System colors
    // are non-editable, non-deletable, and excluded from both customer search
    // and the admin's assignable-color list.
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // family is the canonical search key, unique WITHIN a tenant — every tenant
  // has its own palette (and its own '__unassigned__' sentinel row).
  (t) => [
    uniqueIndex('colors_tenant_family_idx').on(t.tenantId, t.family),
    tenantIsolationPolicy(),
  ],
);

/**
 * Stable family key of the reserved system color that product-image tags fall
 * back to when their assigned color is deleted. The row is seeded in migration
 * 0006 (is_system=true, is_active=false); resolve it at runtime by this family
 * and cache the lookup — never hardcode its uuid.
 */
export const UNASSIGNED_COLOR_FAMILY = '__unassigned__';

export const insertColorSchema = createInsertSchema(colors);
export const selectColorSchema = createSelectSchema(colors);

export type Color = typeof colors.$inferSelect;
export type NewColor = typeof colors.$inferInsert;
