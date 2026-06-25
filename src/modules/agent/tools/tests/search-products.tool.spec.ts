/**
 * Tests for buildSearchProductsTool.
 *
 * The tool has three execution branches:
 *   1. ad_ref fast path — returns products linked to the ad (if any).
 *   2. ad_ref fallthrough + structured / fuzzy search.
 *   3. color normalization via normalizeColor before search.
 *   4. free-text query → searchFuzzy instead of search.
 *
 * After AIA-34 sub-task A: execute receives ctx as 2nd arg; when
 * ctx.requestContext.get('imageLed') === true, ad_ref is ignored and the
 * normal search path runs instead (code-enforced image-over-ad priority).
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

// NestJS Logger is imported by the tool; stub it so there is no console noise.
jest.mock('@nestjs/common', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  })),
}));

import { buildSearchProductsTool } from '../search-products.tool';
import type { ProductsService } from '@/modules/products/products.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal product row returned by service mocks. */
function makeProduct(
  overrides: Partial<{
    id: string;
    name: string;
    priceJod: string;
    colorFamily: string | null;
    occasion: string | null;
    stockStatus: string;
    sizes: string[];
  }> = {},
) {
  return {
    id: 'prod-1',
    name: 'عباءة زرقاء',
    priceJod: '45.000',
    colorFamily: 'blue' as string | null,
    occasion: null as string | null,
    stockStatus: 'in_stock',
    sizes: ['M', 'L'],
    ...overrides,
  };
}

/** Build a ProductsService mock with individual jest.fns for each method.
 * Returns the mock service AND direct references to the actual fns installed on
 * the mock (important: destructure AFTER merging overrides). */
function makeProductsMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const defaults = {
    findByAdRef: jest.fn().mockResolvedValue([]),
    normalizeColor: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    searchFuzzy: jest.fn().mockResolvedValue([]),
    getColorNamesByProducts: jest.fn().mockResolvedValue(new Map<string, string[]>()),
  };

  // Merge: overrides win; then extract the resolved fns so callers get live refs.
  const merged = { ...defaults, ...overrides };

  const mock = merged as unknown as ProductsService;

  return {
    mock,
    findByAdRef: merged.findByAdRef,
    normalizeColor: merged.normalizeColor,
    search: merged.search,
    searchFuzzy: merged.searchFuzzy,
  };
}

/** Build a fake requestContext — mirrors the pattern from escalate-to-human.tool.spec.ts. */
function ctx(vals: Record<string, unknown>) {
  return {
    requestContext: { get: (k: string) => vals[k] },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSearchProductsTool — search_products', () => {
  // -------------------------------------------------------------------------
  // (a) ad_ref fast path: products found → return immediately
  // -------------------------------------------------------------------------
  describe('ad_ref fast path', () => {
    it('calls findByAdRef, maps products correctly, and does NOT call search/searchFuzzy', async () => {
      const adProduct = makeProduct({
        id: '1',
        name: 'A',
        priceJod: '45.000',
        colorFamily: 'red',
        occasion: 'سهرة',
        stockStatus: 'in_stock',
      });
      const { mock, findByAdRef, normalizeColor, search, searchFuzzy } =
        makeProductsMock({
          findByAdRef: jest.fn().mockResolvedValue([adProduct]),
        });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ ad_ref: 'ad-x' }, ctx({}));

      expect(findByAdRef).toHaveBeenCalledWith('ad-x');
      expect(result.products).toHaveLength(1);
      expect(result.products[0]).toEqual({
        id: '1',
        name: 'A',
        price: '45.000',
        color: 'red',
        colors: [],
        category: 'سهرة',
        available: true,
      });
      // price must be a string, not a number
      expect(typeof result.products[0].price).toBe('string');
      expect(search).not.toHaveBeenCalled();
      expect(searchFuzzy).not.toHaveBeenCalled();
      // normalizeColor is not needed on the fast path
      expect(normalizeColor).not.toHaveBeenCalled();
    });

    it('marks available=false when stockStatus is "out"', async () => {
      const outProduct = makeProduct({ stockStatus: 'out' });
      const { mock } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([outProduct]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ ad_ref: 'ad-x' }, ctx({}));

      expect(result.products[0].available).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // (b) ad_ref unmapped → fallthrough to search branch
  // -------------------------------------------------------------------------
  describe('ad_ref fallthrough', () => {
    it('falls through to search when findByAdRef returns [] and uses normalizeColor', async () => {
      const { mock, findByAdRef, normalizeColor, search } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([]),
        normalizeColor: jest.fn().mockResolvedValue('red'),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ ad_ref: 'ad-none', color: 'نبيتي' }, ctx({}));

      expect(findByAdRef).toHaveBeenCalledWith('ad-none');
      expect(normalizeColor).toHaveBeenCalledWith('نبيتي');
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ colorFamily: 'red' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // (c) Color normalization (no ad_ref)
  // -------------------------------------------------------------------------
  describe('color normalization', () => {
    it('normalizes dialect color term and passes colorFamily + mapped fields to search', async () => {
      const { mock, normalizeColor, search } = makeProductsMock({
        normalizeColor: jest.fn().mockResolvedValue('red'),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute(
        {
          color: 'نبيتي',
          category: 'سهرة',
          size: 'L',
          max_price: 50,
        },
        ctx({}),
      );

      expect(normalizeColor).toHaveBeenCalledWith('نبيتي');
      expect(search).toHaveBeenCalledWith({
        colorFamily: 'red',
        size: 'L',
        // tool `category` input → service `occasion` key
        occasion: 'سهرة',
        // max_price number → priceMax string
        priceMax: '50',
      });
    });

    it('passes priceMax as a string (not a number)', async () => {
      const { mock, search } = makeProductsMock({
        normalizeColor: jest.fn().mockResolvedValue('red'),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ color: 'نبيتي', max_price: 100 }, ctx({}));

      const searchArg = search.mock.calls[0][0];
      expect(typeof searchArg.priceMax).toBe('string');
      expect(searchArg.priceMax).toBe('100');
    });

    it('passes occasion as undefined when category is not provided', async () => {
      const { mock, search } = makeProductsMock({
        normalizeColor: jest.fn().mockResolvedValue('blue'),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ color: 'أزرق' }, ctx({}));

      const searchArg = search.mock.calls[0][0];
      expect(searchArg.occasion).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (d) Free-text query → searchFuzzy
  // -------------------------------------------------------------------------
  describe('query branch', () => {
    it('calls searchFuzzy (not search) when query is provided', async () => {
      const { mock, search, searchFuzzy } = makeProductsMock({
        searchFuzzy: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ query: 'فضفاضة' }, ctx({}));

      expect(searchFuzzy).toHaveBeenCalledWith(
        'فضفاضة',
        expect.objectContaining({}),
      );
      expect(search).not.toHaveBeenCalled();
    });

    it('passes the query as the first argument to searchFuzzy', async () => {
      const { mock, searchFuzzy } = makeProductsMock({
        searchFuzzy: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ query: 'عباءة فضفاضة مع حجاب' }, ctx({}));

      expect(searchFuzzy.mock.calls[0][0]).toBe('عباءة فضفاضة مع حجاب');
    });
  });

  // -------------------------------------------------------------------------
  // (e) Empty results
  // -------------------------------------------------------------------------
  describe('empty results', () => {
    it('returns { products: [] } when search resolves to []', async () => {
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ color: 'أحمر' }, ctx({}));

      expect(result).toEqual({ products: [] });
    });

    it('returns { products: [] } when findByAdRef resolves to [] and search also resolves to []', async () => {
      const { mock } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([]),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ ad_ref: 'ad-empty' }, ctx({}));

      expect(result).toEqual({ products: [] });
    });
  });

  // -------------------------------------------------------------------------
  // (f) Top-8 cap
  // -------------------------------------------------------------------------
  describe('top-8 cap', () => {
    it('returns at most 8 products even when search resolves 10', async () => {
      const tenProducts = Array.from({ length: 10 }, (_, i) =>
        makeProduct({ id: `p${i}`, name: `Product ${i}` }),
      );
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue(tenProducts),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({}, ctx({}));

      expect(result.products).toHaveLength(8);
    });

    it('returns at most 8 products via the ad_ref fast path when the ad has 10 products', async () => {
      const tenProducts = Array.from({ length: 10 }, (_, i) =>
        makeProduct({ id: `p${i}` }),
      );
      const { mock } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue(tenProducts),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ ad_ref: 'ad-big' }, ctx({}));

      expect(result.products).toHaveLength(8);
    });
  });

  // -------------------------------------------------------------------------
  // Output shape — price is always a string
  // -------------------------------------------------------------------------
  describe('output mapping', () => {
    it('maps colorFamily to color and occasion to category in output', async () => {
      const p = makeProduct({ colorFamily: 'green', occasion: 'عمل' });
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue([p]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({}, ctx({}));

      expect(result.products[0].color).toBe('green');
      expect(result.products[0].category).toBe('عمل');
    });

    it('outputs color as undefined when colorFamily is null', async () => {
      const p = makeProduct({ colorFamily: null });
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue([p]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({}, ctx({}));

      expect(result.products[0].color).toBeUndefined();
    });

    it('attaches the full available-colour names from getColorNamesByProducts', async () => {
      const p = makeProduct({ id: 'p9', colorFamily: 'green' });
      const colorsMap = new Map<string, string[]>([['p9', ['أخضر', 'أحمر']]]);
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue([p]),
        getColorNamesByProducts: jest.fn().mockResolvedValue(colorsMap),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({}, ctx({}));

      expect(result.products[0].colors).toEqual(['أخضر', 'أحمر']);
    });
  });

  // -------------------------------------------------------------------------
  // (g) Image-led routing — AIA-34 sub-task A
  // -------------------------------------------------------------------------
  describe('image-led routing (imageLed in context)', () => {
    it('ignores ad_ref and calls a search method (not findByAdRef) when imageLed=true', async () => {
      const adProduct = makeProduct({ id: 'ad-p', name: 'From Ad' });
      const searchProduct = makeProduct({ id: 'search-p', name: 'From Search' });
      const { mock, findByAdRef, search } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([adProduct]),
        search: jest.fn().mockResolvedValue([searchProduct]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      // ad_ref is present but imageLed=true → ad_ref must be ignored
      const result = await tool.execute(
        { ad_ref: 'spring-ad' },
        ctx({ imageLed: true }),
      );

      expect(findByAdRef).not.toHaveBeenCalled();
      expect(search).toHaveBeenCalled();
      // result comes from normal search, not from the ad
      expect(result.products[0].id).toBe('search-p');
    });

    it('still uses ad_ref fast path when imageLed is absent from context', async () => {
      const adProduct = makeProduct({ id: 'ad-p', name: 'From Ad' });
      const { mock, findByAdRef, search } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([adProduct]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ ad_ref: 'spring-ad' }, ctx({}));

      expect(findByAdRef).toHaveBeenCalledWith('spring-ad');
      expect(search).not.toHaveBeenCalled();
    });

    it('still uses ad_ref fast path when imageLed is explicitly false', async () => {
      const adProduct = makeProduct({ id: 'ad-p', name: 'From Ad' });
      const { mock, findByAdRef, search } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([adProduct]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      await tool.execute({ ad_ref: 'spring-ad' }, ctx({ imageLed: false }));

      expect(findByAdRef).toHaveBeenCalledWith('spring-ad');
      expect(search).not.toHaveBeenCalled();
    });
  });
});
