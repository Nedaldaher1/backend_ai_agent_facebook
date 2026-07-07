import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import {
  tenantIdColumn,
  tenantIsolationPolicy,
} from '@/modules/tenants/entities/tenant.entity';

/**
 * Control-plane table: the clothing category (e.g. "abaya", "pajama", "dress"),
 * written by the admin side and read by the agent's search path. A category is
 * what a product is tagged with (see products.category_id) and it OWNS the set
 * of structured attributes products of that category expose.
 *
 * The catalog is no longer abaya-only: instead of fixed abaya columns
 * (sleeve/fabric/occasion/embellishment) each category carries its own
 * `attribute_schema` — a list of attribute definitions the admin edits from the
 * UI — and a product stores the matching VALUES under `attributes.values`.
 *
 * `slug` is the stable English key (e.g. "abaya") that feeds the agent's closed
 * vocabulary and the search filter; `name` is the Arabic display label
 * ("عباية"). `attribute_schema` is validated as a typed array, never free jsonb.
 */

/** The kinds of attribute an admin can define on a category. */
export const ATTRIBUTE_TYPES = ['select', 'text', 'number'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/**
 * One admin-defined attribute on a category. `key` is the stable English wire
 * key stored on the product (`attributes.values[key]`); `label` is the Arabic
 * label shown in the form. `options` is required and non-empty for `select`.
 */
export const attributeDefinitionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'key must be a lower_snake_case identifier starting with a letter',
      ),
    label: z.string().trim().min(1),
    type: z.enum(ATTRIBUTE_TYPES),
    options: z
      .array(
        z.object({
          value: z.string().trim().min(1),
          label: z.string().trim().min(1),
        }),
      )
      .optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.type === 'select' && (!def.options || def.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'select attributes must define at least one option',
        path: ['options'],
      });
    }
  });
export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

/**
 * A category's whole attribute schema — the ordered list of definitions.
 * `key`s must be unique so a product's `attributes.values` map is unambiguous.
 */
export const attributeSchemaSchema = z
  .array(attributeDefinitionSchema)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>();
    for (const def of defs) {
      if (seen.has(def.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate attribute key "${def.key}"`,
        });
      }
      seen.add(def.key);
    }
  });

export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Ordered attribute definitions this category exposes on its products.
    attributeSchema: jsonb('attribute_schema')
      .$type<AttributeDefinition[]>()
      .notNull()
      .default([]),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // slug is the canonical key, unique WITHIN a tenant — every tenant seeds its
  // own default categories (e.g. "abaya") at tenant creation.
  (t) => [
    uniqueIndex('product_categories_tenant_slug_idx').on(t.tenantId, t.slug),
    tenantIsolationPolicy(),
  ],
);

export const insertProductCategorySchema = createInsertSchema(
  productCategories,
  {
    slug: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'slug must be a lower_snake_case identifier starting with a letter',
      ),
    attributeSchema: attributeSchemaSchema,
  },
);
export const selectProductCategorySchema = createSelectSchema(
  productCategories,
  { attributeSchema: attributeSchemaSchema },
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
