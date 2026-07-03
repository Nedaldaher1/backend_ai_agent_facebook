/**
 * Tests for buildCheckAvailabilityTool.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildCheckAvailabilityTool } from '../check-availability.tool';
import type { ProductsService } from '@/modules/products/products.service';

// ---------------------------------------------------------------------------
// Minimal products service mock
// ---------------------------------------------------------------------------

function makeProductsMock(checkAvailabilityImpl: jest.Mock): ProductsService {
  return {
    checkAvailability: checkAvailabilityImpl,
  } as unknown as ProductsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCheckAvailabilityTool', () => {
  it('calls checkAvailability with (product_id, size) and maps output fields', async () => {
    const checkAvailability = jest.fn().mockResolvedValue({
      available: true,
      inStockSizes: ['M', 'L'],
      note: undefined,
    });
    const products = makeProductsMock(checkAvailability);
    const tool = buildCheckAvailabilityTool(products) as any;

    const result = await tool.execute({ product_id: 'p1', size: 'M' });

    expect(checkAvailability).toHaveBeenCalledWith('p1', 'M');
    expect(result).toEqual({
      available: true,
      in_stock_sizes: ['M', 'L'],
      note: undefined,
    });
  });

  it('passes undefined size when size is omitted', async () => {
    const checkAvailability = jest.fn().mockResolvedValue({
      available: false,
      inStockSizes: [],
      note: 'المنتج غير متوفر',
    });
    const products = makeProductsMock(checkAvailability);
    const tool = buildCheckAvailabilityTool(products) as any;

    const result = await tool.execute({ product_id: 'p2' });

    expect(checkAvailability).toHaveBeenCalledWith('p2', undefined);
    expect(result.available).toBe(false);
    expect(result.in_stock_sizes).toEqual([]);
    expect(result.note).toBe('المنتج غير متوفر');
  });

  it('propagates note from the service when present', async () => {
    const note = 'نفدت الكميات';
    const checkAvailability = jest.fn().mockResolvedValue({
      available: false,
      inStockSizes: [],
      note,
    });
    const products = makeProductsMock(checkAvailability);
    const tool = buildCheckAvailabilityTool(products) as any;

    const result = await tool.execute({ product_id: 'p3', size: 'XL' });

    expect(result.note).toBe(note);
  });
});
