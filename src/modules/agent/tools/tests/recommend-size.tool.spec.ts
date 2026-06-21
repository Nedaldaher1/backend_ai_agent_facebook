/**
 * Tests for buildRecommendSizeTool.
 *
 * The tool is THIN: it calls SizingService.recommendSize and remaps
 * the single camelCase key (needsHuman → needs_human). No business logic.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildRecommendSizeTool } from '../recommend-size.tool';
import type { SizingService } from '@/modules/sizing/sizing.service';

// ---------------------------------------------------------------------------
// Minimal sizing service mock
// ---------------------------------------------------------------------------

function makeSizingMock(recommendSizeImpl: jest.Mock): SizingService {
  return {
    recommendSize: recommendSizeImpl,
  } as unknown as SizingService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRecommendSizeTool', () => {
  it('calls recommendSize with (weight_kg, height_cm) and returns { size } for a normal weight', async () => {
    const recommendSize = jest.fn().mockResolvedValue({ size: '1' });
    const sizing = makeSizingMock(recommendSize);
    const tool = buildRecommendSizeTool(sizing) as any;

    const result = await tool.execute({ weight_kg: 75, height_cm: 165 });

    expect(recommendSize).toHaveBeenCalledWith(75, 165);
    expect(result).toEqual({ size: '1', note: undefined, needs_human: undefined });
  });

  it('passes height_cm through when provided', async () => {
    const recommendSize = jest.fn().mockResolvedValue({ size: '2' });
    const sizing = makeSizingMock(recommendSize);
    const tool = buildRecommendSizeTool(sizing) as any;

    await tool.execute({ weight_kg: 90, height_cm: 170 });

    expect(recommendSize).toHaveBeenCalledWith(90, 170);
  });

  it('passes undefined for height_cm when it is omitted', async () => {
    const recommendSize = jest.fn().mockResolvedValue({ size: '1' });
    const sizing = makeSizingMock(recommendSize);
    const tool = buildRecommendSizeTool(sizing) as any;

    await tool.execute({ weight_kg: 75 });

    expect(recommendSize).toHaveBeenCalledWith(75, undefined);
  });

  it('maps needsHuman→needs_human and returns size:null when weight is out of range', async () => {
    const note = 'وزنك خارج النطاق المعتاد لمقاساتنا، رح يساعدك فريقنا بالمقاس الأنسب.';
    const recommendSize = jest
      .fn()
      .mockResolvedValue({ size: null, needsHuman: true, note });
    const sizing = makeSizingMock(recommendSize);
    const tool = buildRecommendSizeTool(sizing) as any;

    const result = await tool.execute({ weight_kg: 130 });

    expect(recommendSize).toHaveBeenCalledWith(130, undefined);
    expect(result).toEqual({ size: null, needs_human: true, note });
  });

  it('returns needs_human:undefined (not true) for a normal in-range result', async () => {
    const recommendSize = jest.fn().mockResolvedValue({ size: '1' });
    const sizing = makeSizingMock(recommendSize);
    const tool = buildRecommendSizeTool(sizing) as any;

    const result = await tool.execute({ weight_kg: 75 });

    expect(result.needs_human).toBeUndefined();
    expect(result.size).toBe('1');
  });
});
