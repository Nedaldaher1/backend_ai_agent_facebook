/**
 * Tests for buildGetProductMediaTool.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildGetProductMediaTool } from '../get-product-media.tool';
import type { ProductsService } from '@/modules/products/products.service';

function makeProductsMock(getMediaImpl: jest.Mock): ProductsService {
  return {
    getMedia: getMediaImpl,
  } as unknown as ProductsService;
}

describe('buildGetProductMediaTool', () => {
  it('calls getMedia with product_id and returns media array', async () => {
    const getMedia = jest
      .fn()
      .mockResolvedValue([{ url: 'u1', type: 'image' }]);
    const products = makeProductsMock(getMedia);
    const tool = buildGetProductMediaTool(products) as any;

    const result = await tool.execute({ product_id: 'p1' });

    expect(getMedia).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ media: [{ url: 'u1', type: 'image' }] });
  });

  it('returns an empty media array when the service returns []', async () => {
    const getMedia = jest.fn().mockResolvedValue([]);
    const products = makeProductsMock(getMedia);
    const tool = buildGetProductMediaTool(products) as any;

    const result = await tool.execute({ product_id: 'p-missing' });

    expect(getMedia).toHaveBeenCalledWith('p-missing');
    expect(result).toEqual({ media: [] });
  });

  it('returns multiple media items in the same order the service provides', async () => {
    const mediaItems = [
      { url: 'https://cdn/a.jpg', type: 'image' },
      { url: 'https://cdn/b.jpg', type: 'image' },
      { url: 'https://cdn/c.jpg', type: 'image' },
    ];
    const getMedia = jest.fn().mockResolvedValue(mediaItems);
    const products = makeProductsMock(getMedia);
    const tool = buildGetProductMediaTool(products) as any;

    const result = await tool.execute({ product_id: 'p2' });

    expect(result.media).toHaveLength(3);
    expect(result.media[1].url).toBe('https://cdn/b.jpg');
  });
});
