/**
 * Tests for the find_similar_by_image stub tool.
 *
 * This tool is a const (no factory) and has no service dependencies.
 * The createTool mock makes @mastra/core/tools safe to import under Jest (CJS).
 */

// Must be before the tool import to intercept the createTool call.
jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { findSimilarByImageTool } from '../find-similar-by-image.tool';

describe('findSimilarByImageTool', () => {
  it('resolves with an empty products array and the stub note', async () => {
    // The stub ignores all input and returns the hardcoded Phase-2 placeholder.
    const result = await (findSimilarByImageTool as any).execute({});

    expect(result).toEqual({
      products: [],
      note: 'visual search not available yet',
    });
  });

  it('resolves the same shape even when image_url is provided', async () => {
    const result = await (findSimilarByImageTool as any).execute({
      image_url: 'https://example.com/image.jpg',
    });

    expect(result.products).toEqual([]);
    expect(result.note).toBe('visual search not available yet');
  });
});
