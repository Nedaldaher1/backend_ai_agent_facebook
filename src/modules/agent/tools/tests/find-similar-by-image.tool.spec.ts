/**
 * Tests for buildFindSimilarByImageTool.
 *
 * The tool wraps ProductsService.findSimilarByImage and shapes results exactly
 * like search_products. It must NEVER throw into the agent turn and must return
 * an empty list when there is no image or no good match (so the agent never
 * fabricates products).
 *
 * After AIA-34 sub-task A: the image URL comes from requestContext, NOT from
 * tool input.
 * After AIA-35 sub-task B: target_color is forwarded to findSimilarByImage;
 * normalization lives in the service, not here.
 */

// Must precede the tool import so createTool is the identity mock under Jest (CJS).
jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));
// The tool builds a module-level Logger; stub @nestjs/common (the tool is a
// plain function, not an @Injectable, so only Logger is needed here).
jest.mock('@nestjs/common', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  })),
}));

import { buildFindSimilarByImageTool } from '../find-similar-by-image.tool';
import type { ProductsService } from '@/modules/products/products.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tool = {
  execute: (
    input: { target_color?: string },
    ctx?: { requestContext: { get: (k: string) => unknown } },
  ) => Promise<{ products: unknown[] }>;
};

/** Build a fake requestContext that mirrors what AgentService injects. */
function ctx(vals: Record<string, unknown>) {
  return {
    requestContext: { get: (k: string) => vals[k] },
  };
}

const makeHit = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'عباءة سوداء',
  priceJod: '49.000',
  colorFamily: 'black',
  occasion: 'سهرة',
  stockStatus: 'in_stock',
  imageUrl: 'https://pub.example.com/a.jpg',
  similarity: 0.92,
  ...overrides,
});

describe('buildFindSimilarByImageTool', () => {
  const findSimilarByImage = jest.fn();
  // clearAllMocks (not reset) keeps this implementation across tests.
  const getColorNamesByProducts = jest
    .fn()
    .mockResolvedValue(new Map<string, string[]>());
  const products = {
    findSimilarByImage,
    getColorNamesByProducts,
  } as unknown as ProductsService;

  beforeEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // (a) Valid lastImageUrl in context → maps service results
  // -------------------------------------------------------------------------
  it('calls findSimilarByImage with the URL from context and maps results correctly', async () => {
    findSimilarByImage.mockResolvedValue([
      makeHit(),
      makeHit({
        id: 'p2',
        colorFamily: null,
        occasion: null,
        stockStatus: 'out',
      }),
    ]);
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;
    const result = await tool.execute(
      {},
      ctx({ lastImageUrl: 'https://x/y.jpg' }),
    );

    expect(findSimilarByImage).toHaveBeenCalledWith('https://x/y.jpg', {
      targetColor: undefined,
    });
    expect(result).toEqual({
      products: [
        {
          id: 'p1',
          name: 'عباءة سوداء',
          price: '49.000',
          color: 'black',
          colors: [],
          category: 'سهرة',
          available: true,
        },
        {
          id: 'p2',
          name: 'عباءة سوداء',
          price: '49.000',
          color: undefined,
          colors: [],
          category: undefined,
          available: false,
        },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // (b) No lastImageUrl in context → empty products, service NOT called
  // -------------------------------------------------------------------------
  it('returns empty WITHOUT calling the service when lastImageUrl is absent from context', async () => {
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;
    // ctx with no lastImageUrl key
    const result = await tool.execute({}, ctx({}));
    expect(result).toEqual({ products: [] });
    expect(findSimilarByImage).not.toHaveBeenCalled();
  });

  it('returns empty WITHOUT calling the service when no ctx object is passed at all', async () => {
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;
    const result = await tool.execute({});
    expect(result).toEqual({ products: [] });
    expect(findSimilarByImage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) Service throws → empty products (never throws into agent turn)
  // -------------------------------------------------------------------------
  it('returns empty (never throws) when the pipeline fails', async () => {
    findSimilarByImage.mockRejectedValue(new Error('model down'));
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;
    await expect(
      tool.execute({}, ctx({ lastImageUrl: 'https://x/y.jpg' })),
    ).resolves.toEqual({ products: [] });
  });

  it('returns empty when there are no matches', async () => {
    findSimilarByImage.mockResolvedValue([]);
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;
    await expect(
      tool.execute({}, ctx({ lastImageUrl: 'https://x/y.jpg' })),
    ).resolves.toEqual({ products: [] });
  });

  // -------------------------------------------------------------------------
  // inputSchema — has target_color but NOT image_url
  // -------------------------------------------------------------------------
  it('inputSchema has target_color but no image_url (URL comes from context)', () => {
    const tool = buildFindSimilarByImageTool(products) as any;
    expect(tool.inputSchema.shape).toHaveProperty('target_color');
    expect(tool.inputSchema.shape).not.toHaveProperty('image_url');
  });

  // -------------------------------------------------------------------------
  // (d) target_color is forwarded to findSimilarByImage (normalization is in
  //     the service, not the tool — tool just passes through)
  // -------------------------------------------------------------------------
  it('forwards target_color to findSimilarByImage when provided', async () => {
    findSimilarByImage.mockResolvedValue([]);
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;

    await tool.execute(
      { target_color: 'أسود' },
      ctx({ lastImageUrl: 'https://x/y.jpg' }),
    );

    expect(findSimilarByImage).toHaveBeenCalledWith('https://x/y.jpg', {
      targetColor: 'أسود',
    });
  });

  it('calls findSimilarByImage with targetColor undefined when target_color is absent', async () => {
    findSimilarByImage.mockResolvedValue([]);
    const tool = buildFindSimilarByImageTool(products) as unknown as Tool;

    await tool.execute({}, ctx({ lastImageUrl: 'https://x/y.jpg' }));

    expect(findSimilarByImage).toHaveBeenCalledWith('https://x/y.jpg', {
      targetColor: undefined,
    });
  });
});
