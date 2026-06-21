/**
 * Tests for buildFindSimilarByImageTool.
 *
 * The tool wraps ProductsService.findSimilarByImage and shapes results exactly
 * like search_products. It must NEVER throw into the agent turn and must return
 * an empty list when there is no image or no good match (so the agent never
 * fabricates products).
 *
 * After AIA-34 sub-task A: the image URL comes from requestContext, NOT from
 * tool input. inputSchema is z.object({}).
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
    input: Record<string, never>,
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
  const products = { findSimilarByImage } as unknown as ProductsService;

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

    expect(findSimilarByImage).toHaveBeenCalledWith('https://x/y.jpg');
    expect(result).toEqual({
      products: [
        {
          id: 'p1',
          name: 'عباءة سوداء',
          price: '49.000',
          color: 'black',
          category: 'سهرة',
          available: true,
        },
        {
          id: 'p2',
          name: 'عباءة سوداء',
          price: '49.000',
          color: undefined,
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
  // inputSchema — must be empty (no image_url field)
  // -------------------------------------------------------------------------
  it('inputSchema has no fields (image URL comes from context, not tool input)', () => {
    const tool = buildFindSimilarByImageTool(products) as any;
    expect(Object.keys(tool.inputSchema.shape)).toHaveLength(0);
    expect(tool.inputSchema.shape).not.toHaveProperty('image_url');
  });
});
