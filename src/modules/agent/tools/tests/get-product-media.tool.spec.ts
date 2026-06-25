/**
 * Tests for buildGetProductMediaTool.
 *
 * The tool is a thin adapter over ProductsService.getProductMediaByColors: it
 * forwards product_id + colors, pushes the SERVICE-selected image URLs into the
 * per-turn `mediaSink` on the request context (the Messenger controller drains
 * it), and returns a colour SUMMARY with NO urls.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildGetProductMediaTool } from '../get-product-media.tool';
import type { ProductsService } from '@/modules/products/products.service';

function makeProductsMock(getProductMediaByColors: jest.Mock): ProductsService {
  return { getProductMediaByColors } as unknown as ProductsService;
}

/** Fake request context mirroring what AgentService injects (a mediaSink array). */
function ctx(sink: string[]) {
  return {
    requestContext: { get: (k: string) => (k === 'mediaSink' ? sink : undefined) },
  };
}

describe('buildGetProductMediaTool', () => {
  it('forwards product_id + colors, returns the summary, and pushes URLs into the sink', async () => {
    const getProductMediaByColors = jest.fn().mockResolvedValue({
      productFound: true,
      sentColors: ['أحمر'],
      unavailableColors: ['أزرق'],
      mediaUrls: ['https://x/a.jpg', 'https://x/b.jpg'],
    });
    const tool = buildGetProductMediaTool(
      makeProductsMock(getProductMediaByColors),
    ) as any;
    const sink: string[] = [];

    const result = await tool.execute(
      { product_id: 'p1', colors: ['أحمر', 'أزرق'] },
      ctx(sink),
    );

    expect(getProductMediaByColors).toHaveBeenCalledWith('p1', ['أحمر', 'أزرق']);
    expect(result).toEqual({
      sent_colors: ['أحمر'],
      unavailable_colors: ['أزرق'],
      sent_image_count: 2,
      product_found: true,
    });
    // URLs go to the side-channel, NOT the agent-facing result.
    expect(sink).toEqual(['https://x/a.jpg', 'https://x/b.jpg']);
  });

  it('passes colors through as undefined when the agent omits them (send all)', async () => {
    const getProductMediaByColors = jest.fn().mockResolvedValue({
      productFound: true,
      sentColors: ['أحمر', 'أزرق'],
      unavailableColors: [],
      mediaUrls: ['https://x/a.jpg'],
    });
    const tool = buildGetProductMediaTool(
      makeProductsMock(getProductMediaByColors),
    ) as any;
    const sink: string[] = [];

    const result = await tool.execute({ product_id: 'p1' }, ctx(sink));

    expect(getProductMediaByColors).toHaveBeenCalledWith('p1', undefined);
    expect(result.sent_image_count).toBe(1);
    expect(result.product_found).toBe(true);
    expect(sink).toEqual(['https://x/a.jpg']);
  });

  it('reports product_found=false and sends nothing for a missing product', async () => {
    const getProductMediaByColors = jest.fn().mockResolvedValue({
      productFound: false,
      sentColors: [],
      unavailableColors: [],
      mediaUrls: [],
    });
    const tool = buildGetProductMediaTool(
      makeProductsMock(getProductMediaByColors),
    ) as any;
    const sink: string[] = [];

    const result = await tool.execute(
      { product_id: 'p-missing', colors: ['أحمر'] },
      ctx(sink),
    );

    expect(result).toEqual({
      sent_colors: [],
      unavailable_colors: [],
      sent_image_count: 0,
      product_found: false,
    });
    expect(sink).toEqual([]);
  });

  it('does not throw when no request context is provided (no sink to fill)', async () => {
    const getProductMediaByColors = jest.fn().mockResolvedValue({
      productFound: true,
      sentColors: [],
      unavailableColors: [],
      mediaUrls: ['https://x/a.jpg'],
    });
    const tool = buildGetProductMediaTool(
      makeProductsMock(getProductMediaByColors),
    ) as any;

    const result = await tool.execute({ product_id: 'p1' });

    expect(result.product_found).toBe(true);
    expect(result.sent_image_count).toBe(1);
  });
});
