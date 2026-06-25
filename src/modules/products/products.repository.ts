import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  products,
  type NewProduct,
  type Product,
} from './entities/product.entity';
import { adProductLinks } from './entities/ad-product-link.entity';
import { productImageColors } from './entities/product-image-color.entity';
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
  size?: string;
  fabric?: string;
  occasion?: string;
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
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Distinct non-null values of a free-text attribute over PUBLISHED products.
   * Feeds the soft occasion/fabric vocabulary that guides vision attribute
   * extraction. Restricted to known columns — never interpolates arbitrary SQL.
   */
  async distinctPublishedAttribute(
    attribute: 'occasion' | 'fabric',
  ): Promise<string[]> {
    const col = attribute === 'occasion' ? products.occasion : products.fabric;
    const rows = await this.db
      .selectDistinct({ value: col })
      .from(products)
      .where(and(eq(products.isPublished, true), isNotNull(col)))
      .orderBy(asc(col));
    return rows
      .map((r) => r.value)
      .filter((v): v is string => v != null && v.length > 0);
  }

  /** Translate a filter into a list of SQL conditions (parameterized). */
  private buildConditions(filter: ProductFilter): SQL[] {
    const conditions: SQL[] = [];

    if (filter.isPublished !== undefined) {
      conditions.push(eq(products.isPublished, filter.isPublished));
    }
    if (filter.colorFamily) {
      // Variant-aware colour match: the product's PRIMARY color_family OR any of
      // its per-image variant colours (product_image_colors → colors.family). So
      // a product whose primary is green but which has a red variant image still
      // matches a search for "red" — multi-colour products were previously
      // matchable only on their single primary colour.
      conditions.push(
        sql`(${products.colorFamily} = ${filter.colorFamily} OR EXISTS (
          SELECT 1 FROM ${productImageColors}
          JOIN ${colors} ON ${colors.id} = ${productImageColors.colorId}
          WHERE ${productImageColors.productId} = ${products.id}
            AND ${colors.family} = ${filter.colorFamily}
        ))`,
      );
    }
    if (filter.size) {
      conditions.push(arrayContains(products.sizes, [filter.size]));
    }
    if (filter.fabric) {
      conditions.push(eq(products.fabric, filter.fabric));
    }
    if (filter.occasion) {
      conditions.push(eq(products.occasion, filter.occasion));
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
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    const conditions = this.buildConditions(filter);

    return this.db
      .select()
      .from(products)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(direction(products.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Total rows matching `filter` (for pagination), ignoring limit/offset. */
  async count(filter: ProductFilter = {}): Promise<number> {
    const conditions = this.buildConditions(filter);
    const [row] = await this.db
      .select({ value: count() })
      .from(products)
      .where(conditions.length ? and(...conditions) : undefined);
    return row?.value ?? 0;
  }

  /** Internal lookup (no publish gate); callers decide whether to expose it. */
  async findById(id: string): Promise<Product | undefined> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    return row;
  }

  async insert(input: NewProduct): Promise<Product> {
    const [row] = await this.db.insert(products).values(input).returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewProduct>,
  ): Promise<Product | undefined> {
    const [row] = await this.db
      .update(products)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row;
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
   */
  async appendImageUrls(
    id: string,
    urls: string[],
  ): Promise<Product | undefined> {
    if (urls.length === 0) {
      return this.findById(id);
    }
    const newKeys = sql`array[${sql.join(
      urls.map((u) => sql`${u}`),
      sql`, `,
    )}]::text[]`;
    const [row] = await this.db
      .update(products)
      .set({
        imageUrls: sql`coalesce(${products.imageUrls}, '{}'::text[]) || ${newKeys}`,
        updatedAt: new Date(),
      })
      .where(eq(products.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<Product | undefined> {
    const [row] = await this.db
      .delete(products)
      .where(eq(products.id, id))
      .returning();
    return row;
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<Product | undefined> {
    const [row] = await this.db
      .update(products)
      .set({ isPublished, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row;
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
    const [row] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.sku, sku), eq(products.isPublished, true)))
      .limit(1);
    return row;
  }

  /**
   * Return all published products linked to the given ad reference, ordered by
   * the position column so the agent surfaces them in the admin-configured order.
   * Only active ad links (is_active = true) are followed.
   */
  async findByAdRef(adRef: string): Promise<Product[]> {
    const productCols = getTableColumns(products);
    const rows = await this.db
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
    const WORD_SIM = 0.5;
    const tokenConds = tokens.map(
      (t) => sql`(
        word_similarity(${t}, ${products.name}) >= ${WORD_SIM}
        OR word_similarity(${t}, coalesce(${products.description}, '')) >= ${WORD_SIM}
        OR word_similarity(${t}, ${tagsText}) >= ${WORD_SIM}
        OR ${products.name} ILIKE ${'%' + t + '%'}
        OR ${tagsText} ILIKE ${'%' + t + '%'}
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

    return this.db
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
  }
}
