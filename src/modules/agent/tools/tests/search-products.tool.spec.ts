/**
 * Tests for buildSearchProductsTool.
 *
 * The tool has three execution branches:
 *   1. ad_ref fast path — returns products linked to the ad (if any).
 *   2. ad_ref fallthrough + structured / fuzzy search.
 *   3. color normalization via normalizeColor before search.
 *   4. free-text query → searchFuzzy instead of search.
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

      const result = await tool.execute({ ad_ref: 'ad-x' });

      expect(findByAdRef).toHaveBeenCalledWith('ad-x');
      expect(result.products).toHaveLength(1);
      expect(result.products[0]).toEqual({
        id: '1',
        name: 'A',
        price: '45.000',
        color: 'red',
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

      const result = await tool.execute({ ad_ref: 'ad-x' });

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

      await tool.execute({ ad_ref: 'ad-none', color: 'نبيتي' });

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

      await tool.execute({
        color: 'نبيتي',
        category: 'سهرة',
        size: 'L',
        max_price: 50,
      });

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

      await tool.execute({ color: 'نبيتي', max_price: 100 });

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

      await tool.execute({ color: 'أزرق' });

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

      await tool.execute({ query: 'فضفاضة' });

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

      await tool.execute({ query: 'عباءة فضفاضة مع حجاب' });

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

      const result = await tool.execute({ color: 'أحمر' });

      expect(result).toEqual({ products: [] });
    });

    it('returns { products: [] } when findByAdRef resolves to [] and search also resolves to []', async () => {
      const { mock } = makeProductsMock({
        findByAdRef: jest.fn().mockResolvedValue([]),
        search: jest.fn().mockResolvedValue([]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({ ad_ref: 'ad-empty' });

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

      const result = await tool.execute({});

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

      const result = await tool.execute({ ad_ref: 'ad-big' });

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

      const result = await tool.execute({});

      expect(result.products[0].color).toBe('green');
      expect(result.products[0].category).toBe('عمل');
    });

    it('outputs color as undefined when colorFamily is null', async () => {
      const p = makeProduct({ colorFamily: null });
      const { mock } = makeProductsMock({
        search: jest.fn().mockResolvedValue([p]),
      });
      const tool = buildSearchProductsTool(mock) as any;

      const result = await tool.execute({});

      expect(result.products[0].color).toBeUndefined();
    });
  });
});
