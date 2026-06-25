/**
 * Tests for buildListAllProductsTool.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildListAllProductsTool } from '../list-all-products.tool';
import type { ProductsService } from '@/modules/products/products.service';

function makeProductsMock(
  listPublished: jest.Mock,
  getColorNamesByProducts: jest.Mock = jest
    .fn()
    .mockResolvedValue(new Map<string, string[]>()),
): ProductsService {
  return { listPublished, getColorNamesByProducts } as unknown as ProductsService;
}

describe('buildListAllProductsTool', () => {
  it('returns all published products mapped to the tool shape, with total', async () => {
    const listPublished = jest.fn().mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'عباية صيفي',
          priceJod: '12.000',
          colorFamily: 'green',
          occasion: 'daily',
          stockStatus: 'in_stock',
        },
        {
          id: 'p2',
          name: 'عباية سهرة',
          priceJod: '25.500',
          colorFamily: null,
          occasion: null,
          stockStatus: 'out',
        },
      ],
      total: 2,
      limit: 30,
      offset: 0,
    });
    const tool = buildListAllProductsTool(makeProductsMock(listPublished)) as any;

    const result = await tool.execute();

    // Publish gate is enforced inside listPublished — called with {} filter + cap.
    expect(listPublished).toHaveBeenCalledWith({}, { limit: 15 });
    expect(result.total).toBe(2);
    expect(result.products).toEqual([
      {
        id: 'p1',
        name: 'عباية صيفي',
        price: '12.000',
        color: 'green',
        colors: [],
        category: 'daily',
        available: true,
      },
      {
        id: 'p2',
        name: 'عباية سهرة',
        price: '25.500',
        color: undefined,
        colors: [],
        category: undefined,
        available: false, // stockStatus 'out' → unavailable
      },
    ]);
  });

  it('attaches each product its available-colour names from getColorNamesByProducts', async () => {
    const listPublished = jest.fn().mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'عباية',
          priceJod: '12.000',
          colorFamily: 'green',
          occasion: 'daily',
          stockStatus: 'in_stock',
        },
      ],
      total: 1,
      limit: 30,
      offset: 0,
    });
    const colorsMap = new Map<string, string[]>([['p1', ['أخضر', 'أحمر', 'أسود']]]);
    const tool = buildListAllProductsTool(
      makeProductsMock(listPublished, jest.fn().mockResolvedValue(colorsMap)),
    ) as any;

    const result = await tool.execute();

    expect(result.products[0].colors).toEqual(['أخضر', 'أحمر', 'أسود']);
  });

  it('returns an empty list (total 0) when the catalog has no published products', async () => {
    const listPublished = jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 30,
      offset: 0,
    });
    const tool = buildListAllProductsTool(makeProductsMock(listPublished)) as any;

    const result = await tool.execute();

    expect(result.products).toEqual([]);
    expect(result.total).toBe(0);
  });
});
