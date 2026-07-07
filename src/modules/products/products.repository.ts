import { Injectable } from '@nestjs/common';
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { TenantDb } from '@/core/tenancy/tenant-db';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  products,
  type NewProduct,
  type Product,
} from './entities/product.entity';
import { adProductLinks } from './entities/ad-product-link.entity';
import { productImageColors } from './entities/product-image-color.entity';
import { productImageDescriptions } from './entities/product-image-description.entity';
import { colors } from './entities/color.entity';
import { tokenizeSearchQuery } from './search-tokenize.util';

/**
 * Filters for the product catalog. `isPublished` is an explicit field so the
 * publish gate is decided by the caller (service): admin lists pass it through,
 * the agent path forces `true`. Price bounds are strings (numeric is a string
 * end-to-end) and are compared as numeric in SQL — never as floats or text.
 */
export interface ProductFilter {
  colorFamily?: string;
  /**
   * Match ANY of these families (primary OR variant image colors). Set by the
   * search path when a customer term fans out to several canonical families
   * ("اخضر" → green + light_green). Combined with `colorFamily` when both given.
   */
  colorFamilies?: string[];
  size?: string;
  /**
   * Exact-match structured attributes, keyed by the attribute `key` defined on
   * the product's category (e.g. `{ fabric: 'crepe', occasion: 'soiree' }`).
   * Matched against the product's `attributes.values` jsonb. Replaces the fixed
   * fabric/occasion columns now that attributes are per-category and dynamic.
   */
  attributes?: Record<string, string>;
  stockStatus?: string;
  tags?: string[];
  search?: string;
  priceMin?: string;
  priceMax?: string;
  isPublished?: boolean;
}

/**
 * Sole owner of product SQL. Services call these methods; nothing above this
 * layer touches the database or builds queries. No business logic here — the
 * publish gate is a filter the service sets, not a rule this layer invents.
 */
@Injectable()
export class ProductsRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * Distinct non-null values of a free-text attribute over PUBLISHED products.
   * Feeds the soft occasion/fabric vocabulary that guides vision attribute
   * extraction. Restricted to known columns — never interpolates arbitrary SQL.
   */
  async distinctPublishedAttribute(attributeKey: string): Promise<string[]> {
    return this.tenantDb.tx(async (db) => {
      // attributes.values[key] over published products. The key is a bound
      // parameter (never interpolated), and jsonb ->> yields text.
      const value = sql<
        string | null
      >`${products.attributes}->'values'->>${attributeKey}`;
      const rows = await db
        .selectDistinct({ value })
        .from(products)
        .where(and(eq(products.isPublished, true), isNotNull(value)))
        .orderBy(asc(value));
      return rows
        .map((r) => r.value)
        .filter((v): v is string => v != null && v.length > 0);
    });
  }

  /** Translate a filter into a list of SQL conditions (parameterized). */
  private buildConditions(filter: ProductFilter): SQL[] {
    const conditions: SQL[] = [];

    if (filter.isPublished !== undefined) {
      conditions.push(eq(products.isPublished, filter.isPublished));
    }
    // Variant-aware colour match: the product's PRIMARY color_family OR any of
    // its per-image variant colours (product_image_colors → colors.family). So
    // a product whose primary is green but which has a red variant image still
    // matches a search for "red" — multi-colour products were previously
    // matchable only on their single primary colour. `colorFamilies` (a term
    // that fanned out, e.g. "اخضر" → green + light_green) matches ANY listed
    // family; a single `colorFamily` is folded into the same IN list.
    const families = [
      ...(filter.colorFamily ? [filter.colorFamily] : []),
      ...(filter.colorFamilies ?? []),
    ];
    if (families.length > 0) {
      const familyList = sql.join(
        families.map((f) => sql`${f}`),
        sql`, `,
      );
      conditions.push(
        sql`(${products.colorFamily} IN (${familyList}) OR EXISTS (
          SELECT 1 FROM ${productImageColors}
          JOIN ${colors} ON ${colors.id} = ${productImageColors.colorId}
          WHERE ${productImageColors.productId} = ${products.id}
            AND ${colors.family} IN (${familyList})
        ))`,
      );
    }
    if (filter.size) {
      // sizes is a jsonb array of { label, ... }; match by label via containment.
      const needle = JSON.stringify([{ label: filter.size }]);
      conditions.push(sql`${products.sizes} @> ${needle}::jsonb`);
    }
    if (filter.attributes) {
      for (const [key, value] of Object.entries(filter.attributes)) {
        conditions.push(
          sql`${products.attributes}->'values'->>${key} = ${value}`,
        );
      }
    }
    if (filter.stockStatus) {
      conditions.push(eq(products.stockStatus, filter.stockStatus));
    }
    if (filter.tags && filter.tags.length > 0) {
      conditions.push(arrayOverlaps(products.tags, filter.tags));
    }
    if (filter.search) {
      conditions.push(ilike(products.name, `%${filter.search}%`));
    }
    // numeric(10,3) is returned/accepted as a string; compare as numeric in SQL
    // with bound parameters so the comparison is correct and never float math.
    if (filter.priceMin !== undefined) {
      conditions.push(sql`${products.priceJod} >= ${filter.priceMin}`);
    }
    if (filter.priceMax !== undefined) {
      conditions.push(sql`${products.priceJod} <= ${filter.priceMax}`);
    }

    return conditions;
  }

  /** List products matching `filter`, paginated and ordered by created_at. */
  async list(
    filter: ProductFilter = {},
    opts: ListOptions = {},
  ): Promise<Product[]> {
    return this.tenantDb.tx(async (db) => {
      const { limit, offset, orderBy } = normalizeListOptions(opts);
      const direction = orderBy === 'asc' ? asc : desc;
      const conditions = this.buildConditions(filter);

      return db
        .select()
        .from(products)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(direction(products.createdAt))
        .limit(limit)
        .offset(offset);
    });
  }

  /** Total rows matching `filter` (for pagination), ignoring limit/offset. */
  async count(filter: ProductFilter = {}): Promise<number> {
    return this.tenantDb.tx(async (db) => {
      const conditions = this.buildConditions(filter);
      const [row] = await db
        .select({ value: count() })
        .from(products)
        .where(conditions.length ? and(...conditions) : undefined);
      return row?.value ?? 0;
    });
  }

  /** Internal lookup (no publish gate); callers decide whether to expose it. */
  async findById(id: string): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      return row;
    });
  }

  async insert(input: NewProduct): Promise<Product> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db.insert(products).values(input).returning();
      return row;
    });
  }

  async updateById(
    id: string,
    patch: Partial<NewProduct>,
  ): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .update(products)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(products.id, id))
        .returning();
      return row;
    });
  }

  /**
   * Append image URLs to image_urls in a single atomic statement (no
   * read-modify-write, so concurrent uploads don't clobber each other).
   * coalesce handles a NULL column.
   *
   * The new keys are emitted as a parameterized `array[$1, $2, ...]::text[]`
   * constructor. Interpolating the JS array directly (`${urls}::text[]`) makes
   * drizzle bind each element as a separate scalar param, so a single key
   * renders as `'key'::text[]` and Postgres rejects it with "malformed array
   * literal"; building the ARRAY[] explicitly keeps every element parameterized.
   *
   * The empty-`urls` branch re-runs findById's exact query against the
   * tx-scoped `db` (instead of calling `this.findById`) so the whole method
   * stays inside the ONE transaction opened here.
   */
  async appendImageUrls(
    id: string,
    urls: string[],
  ): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      if (urls.length === 0) {
        const [row] = await db
          .select()
          .from(products)
          .where(eq(products.id, id))
          .limit(1);
        return row;
      }
      const newKeys = sql`array[${sql.join(
        urls.map((u) => sql`${u}`),
        sql`, `,
      )}]::text[]`;
      const [row] = await db
        .update(products)
        .set({
          imageUrls: sql`coalesce(${products.imageUrls}, '{}'::text[]) || ${newKeys}`,
          updatedAt: new Date(),
        })
        .where(eq(products.id, id))
        .returning();
      return row;
    });
  }

  async deleteById(id: string): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .delete(products)
        .where(eq(products.id, id))
        .returning();
      return row;
    });
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .update(products)
        .set({ isPublished, updatedAt: new Date() })
        .where(eq(products.id, id))
        .returning();
      return row;
    });
  }

  /**
   * Find a published product by its SKU.
   *
   * Publish gate is enforced by this query (is_published = true). Returns
   * undefined when no published product matches the SKU (including when the
   * SKU belongs to an unpublished product). Used by the WS3 ad-attribution
   * product resolver so the agent never surfaces unpublished products via ads.
   *
   * SKU convention: the admin assigns one SKU per product variant (each color
   * is its own product row). The ad's `product_id` field in ads_context_data
   * is expected to match this SKU exactly (case-sensitive, as stored).
   */
  async findPublishedBySku(sku: string): Promise<Product | undefined> {
    return this.tenantDb.tx(async (db) => {
      const [row] = await db
        .select()
        .from(products)
        .where(and(eq(products.sku, sku), eq(products.isPublished, true)))
        .limit(1);
      return row;
    });
  }

  /**
   * Return all published products linked to the given ad reference, ordered by
   * the position column so the agent surfaces them in the admin-configured order.
   * Only active ad links (is_active = true) are followed.
   */
  async findByAdRef(adRef: string): Promise<Product[]> {
    return this.tenantDb.tx(async (db) => {
      const productCols = getTableColumns(products);
      const rows = await db
        .select(productCols)
        .from(adProductLinks)
        .innerJoin(products, eq(adProductLinks.productId, products.id))
        .where(
          and(
            eq(adProductLinks.adRef, adRef),
            eq(adProductLinks.isActive, true),
            eq(products.isPublished, true),
          ),
        )
        .orderBy(asc(adProductLinks.position));
      return rows;
    });
  }

  /**
   * Full-text fuzzy search on product name + description using pg_trgm.
   * Structured conditions from buildConditions (including isPublished) are
   * AND-ed with the similarity predicates so publish gate + filters still apply.
   *
   * NOTE: A GIN index on (name, description) would speed this up for large
   * catalogs; that is tracked in the catalog-indexing ticket.
   *
   * @param query   Free-form search text from the customer.
   * @param filter  Structured filter (must include isPublished for the gate).
   * @param limit   Maximum rows returned; default 8.
   */
  async searchFuzzy(
    query: string,
    filter: ProductFilter,
    limit = 8,
  ): Promise<Product[]> {
    return this.tenantDb.tx(async (db) => {
      const conditions = this.buildConditions(filter);
      const tokens = tokenizeSearchQuery(query);

      // Text the tokens are matched against: name, description, and the joined
      // tags array (so a tag like "قطن" is searchable). NULL-safe.
      const tagsText = sql`coalesce(array_to_string(${products.tags}, ' '), '')`;

      // Per-token, WORD-level match. `word_similarity(token, text)` finds the token
      // INSIDE a longer text — "عباية" scores 1.0 against "عباية صيفي تطريز زهور" —
      // which whole-string `similarity()` cannot do for an Arabic sentence. ILIKE
      // adds exact-substring hits trigrams can miss. 0.5 keeps unrelated words out
      // ("فستان"/"بنطلون" score 0) — calibrated against the live catalog.
      //
      // Per-image descriptions count too: admins describe variants there ("عباية
      // لون بيج بتتميز بالتطريز عند الصدر") while the product name can be a bare
      // SKU-style label ("عباية صيفي #001") — without this EXISTS such a product
      // is unfindable by the very words the admin wrote for it.
      const WORD_SIM = 0.5;
      const tokenConds = tokens.map(
        (t) => sql`(
          word_similarity(${t}, ${products.name}) >= ${WORD_SIM}
          OR word_similarity(${t}, coalesce(${products.description}, '')) >= ${WORD_SIM}
          OR word_similarity(${t}, ${tagsText}) >= ${WORD_SIM}
          OR ${products.name} ILIKE ${'%' + t + '%'}
          OR ${tagsText} ILIKE ${'%' + t + '%'}
          OR EXISTS (
            SELECT 1 FROM ${productImageDescriptions}
            WHERE ${productImageDescriptions.productId} = ${products.id}
              AND word_similarity(${t}, ${productImageDescriptions.description}) >= ${WORD_SIM}
          )
        )`,
      );

      // Whole-query trigram match kept as a coarse OR (helps multi-word name
      // queries like "عباية صيفي"); threshold lowered from the old 0.3 since the
      // per-token predicate is the primary signal now. With no usable tokens
      // (e.g. an all-stopword query) this whole-query clause is the only text
      // condition; the service layer falls back to a structured list if it misses.
      const wholeQuery = sql`(
        similarity(${products.name}, ${query}) >= 0.2
        OR similarity(coalesce(${products.description}, ''), ${query}) >= 0.2
      )`;

      const textCondition =
        tokenConds.length > 0
          ? sql`(${sql.join([...tokenConds, wholeQuery], sql` OR `)})`
          : wholeQuery;

      return db
        .select()
        .from(products)
        .where(and(...conditions, textCondition))
        .orderBy(
          sql`greatest(
            word_similarity(${query}, ${products.name}),
            similarity(${products.name}, ${query}),
            similarity(coalesce(${products.description}, ''), ${query})
          ) DESC`,
        )
        .limit(limit);
    });
  }

  /**
   * Published products by id set, unordered (callers re-order — the semantic
   * search preserves its own relevance ranking). Publish gate enforced here so
   * an embedding row pointing at a since-unpublished product can never leak.
   */
  async findPublishedByIds(ids: string[]): Promise<Product[]> {
    return this.tenantDb.tx(async (db) => {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(products)
        .where(and(inArray(products.id, ids), eq(products.isPublished, true)));
    });
  }
}
