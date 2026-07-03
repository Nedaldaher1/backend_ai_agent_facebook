/**
 * Tests for buildRecommendSizeTool.
 *
 * The tool fetches the product (published only) and asks SizingService to pick
 * a size from that product's own sizes, remapping needsHuman → needs_human.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildRecommendSizeTool } from '../recommend-size.tool';
import type { ProductsService } from '@/modules/products/products.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import type { ProductSize } from '@/modules/products/entities/product.entity';

const SIZES: ProductSize[] = [
  { label: '1', minWeightKg: 60, maxWeightKg: 90 },
  { label: '2', minWeightKg: 90, maxWeightKg: 120 },
];

function makeProductsMock(getById: jest.Mock): ProductsService {
  return { getById } as unknown as ProductsService;
}

function makeSizingMock(impl: jest.Mock): SizingService {
  return { recommendSizeForProduct: impl };
}

describe('buildRecommendSizeTool', () => {
  it('fetches the published product and returns { size } for a normal weight', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 'p1', sizes: SIZES });
    const recommend = jest.fn().mockReturnValue({ size: '1' });
    const tool = buildRecommendSizeTool(
      makeProductsMock(getById),
      makeSizingMock(recommend),
    ) as any;

    const result = await tool.execute({
      product_id: 'p1',
      weight_kg: 75,
      height_cm: 165,
    });

    expect(getById).toHaveBeenCalledWith('p1', { publishedOnly: true });
    expect(recommend).toHaveBeenCalledWith(SIZES, 75, 165);
    expect(result).toEqual({
      size: '1',
      note: undefined,
      needs_human: undefined,
    });
  });

  it('maps needsHuman→needs_human for an out-of-range weight', async () => {
    const note =
      'وزنك خارج نطاق مقاسات هذا المنتج، رح يساعدك فريقنا بالمقاس الأنسب.';
    const getById = jest.fn().mockResolvedValue({ id: 'p1', sizes: SIZES });
    const recommend = jest
      .fn()
      .mockReturnValue({ size: null, needsHuman: true, note });
    const tool = buildRecommendSizeTool(
      makeProductsMock(getById),
      makeSizingMock(recommend),
    ) as any;

    const result = await tool.execute({ product_id: 'p1', weight_kg: 200 });

    expect(result).toEqual({ size: null, needs_human: true, note });
  });

  it('soft-escalates when the product is missing/unpublished', async () => {
    const getById = jest.fn().mockRejectedValue(new Error('not found'));
    const recommend = jest.fn();
    const tool = buildRecommendSizeTool(
      makeProductsMock(getById),
      makeSizingMock(recommend),
    ) as any;

    const result = await tool.execute({ product_id: 'ghost', weight_kg: 75 });

    expect(recommend).not.toHaveBeenCalled();
    expect(result.size).toBeNull();
    expect(result.needs_human).toBe(true);
    expect(result.note).toBeTruthy();
  });
});
