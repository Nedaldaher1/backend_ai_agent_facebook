/**
 * Tests for buildGetProductForOrderTool.
 *
 * The tool is thin: it delegates all logic to ProductsService.resolveForOrder
 * and only renames fields from camelCase (service) to snake_case (agent schema).
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildGetProductForOrderTool } from '../get-product-for-order.tool';
import type { ProductsService } from '@/modules/products/products.service';

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeProductsMock(resolveForOrderImpl: jest.Mock): ProductsService {
  return {
    resolveForOrder: resolveForOrderImpl,
  } as unknown as ProductsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildGetProductForOrderTool', () => {
  it('maps camelCase service result to snake_case tool output (in-stock product)', async () => {
    const resolveForOrder = jest.fn().mockResolvedValue({
      found: true,
      product: {
        productId: 'prod-uuid-1',
        storageKey: 'images/primary.jpg',
        name: 'عباءة سوداء فاخرة',
        priceJod: '75.000',
        colorFamily: 'black',
        available: true,
        availableSizes: ['M', 'L', 'XL'],
      },
    });
    const products = makeProductsMock(resolveForOrder);
    const tool = buildGetProductForOrderTool(products) as any;

    const result = await tool.execute({ product_id: 'prod-uuid-1' });

    expect(resolveForOrder).toHaveBeenCalledWith('prod-uuid-1');
    expect(result).toEqual({
      found: true,
      product: {
        product_id: 'prod-uuid-1',
        storage_key: 'images/primary.jpg',
        name: 'عباءة سوداء فاخرة',
        price: '75.000',
        color: 'black',
        available: true,
        available_sizes: ['M', 'L', 'XL'],
      },
    });
  });

  it('maps colorFamily null to color omitted (undefined)', async () => {
    const resolveForOrder = jest.fn().mockResolvedValue({
      found: true,
      product: {
        productId: 'prod-uuid-2',
        storageKey: 'images/p2.jpg',
        name: 'عباءة بلا لون محدد',
        priceJod: '55.000',
        colorFamily: null,
        available: true,
        availableSizes: ['S'],
      },
    });
    const products = makeProductsMock(resolveForOrder);
    const tool = buildGetProductForOrderTool(products) as any;

    const result = await tool.execute({ product_id: 'prod-uuid-2' });

    expect(result.found).toBe(true);
    // color is optional in the output schema; null colorFamily => undefined => field absent
    expect(result.product.color).toBeUndefined();
    expect(result.product.available_sizes).toEqual(['S']);
  });

  it('returns { found: false } (no product key) when service returns found:false', async () => {
    const resolveForOrder = jest.fn().mockResolvedValue({ found: false });
    const products = makeProductsMock(resolveForOrder);
    const tool = buildGetProductForOrderTool(products) as any;

    const result = await tool.execute({ product_id: 'missing-uuid' });

    expect(resolveForOrder).toHaveBeenCalledWith('missing-uuid');
    expect(result).toEqual({ found: false });
    expect(result.product).toBeUndefined();
  });

  it('maps available_sizes to [] and available:false for out-of-stock', async () => {
    const resolveForOrder = jest.fn().mockResolvedValue({
      found: true,
      product: {
        productId: 'prod-uuid-3',
        storageKey: 'images/p3.jpg',
        name: 'عباءة نافد مخزونها',
        priceJod: '60.000',
        colorFamily: 'red',
        available: false,
        availableSizes: [],
      },
    });
    const products = makeProductsMock(resolveForOrder);
    const tool = buildGetProductForOrderTool(products) as any;

    const result = await tool.execute({ product_id: 'prod-uuid-3' });

    expect(result.found).toBe(true);
    expect(result.product.available).toBe(false);
    expect(result.product.available_sizes).toEqual([]);
    expect(result.product.storage_key).toBe('images/p3.jpg');
  });
});
