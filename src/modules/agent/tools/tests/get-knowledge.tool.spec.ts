/**
 * Tests for buildGetKnowledgeTool.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildGetKnowledgeTool } from '../get-knowledge.tool';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';

function makeKnowledgeMock(getRelevantImpl: jest.Mock): KnowledgeService {
  return {
    getRelevant: getRelevantImpl,
  } as unknown as KnowledgeService;
}

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'k1',
  title: 'سياسة الإرجاع',
  content: 'يمكن الإرجاع خلال 7 أيام',
  category: 'returns',
  productId: null,
  situation: null,
  tags: [],
  priority: 0,
  isPublished: true,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('buildGetKnowledgeTool', () => {
  it('forwards query, productIds and category to getRelevant', async () => {
    const getRelevant = jest.fn().mockResolvedValue([]);
    const knowledge = makeKnowledgeMock(getRelevant);
    const tool = buildGetKnowledgeTool(knowledge) as any;

    await tool.execute({
      query: 'كيف أرجع المنتج',
      product_ids: ['p1', 'p2'],
      category: 'returns',
    });

    expect(getRelevant).toHaveBeenCalledTimes(1);
    expect(getRelevant).toHaveBeenCalledWith({
      query: 'كيف أرجع المنتج',
      productIds: ['p1', 'p2'],
      category: 'returns',
    });
  });

  it('maps entries to output shape including product_id when set', async () => {
    const entry = makeEntry({
      id: 'k1',
      productId: 'p1',
      category: 'product_info',
    });
    const getRelevant = jest.fn().mockResolvedValue([entry]);
    const knowledge = makeKnowledgeMock(getRelevant);
    const tool = buildGetKnowledgeTool(knowledge) as any;

    const result = await tool.execute({ product_ids: ['p1'] });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      id: 'k1',
      title: 'سياسة الإرجاع',
      content: 'يمكن الإرجاع خلال 7 أيام',
      category: 'product_info',
      product_id: 'p1',
    });
  });

  it('omits product_id from output when the entry productId is null', async () => {
    const entry = makeEntry({
      id: 'k2',
      productId: null,
      category: 'shipping',
    });
    const getRelevant = jest.fn().mockResolvedValue([entry]);
    const knowledge = makeKnowledgeMock(getRelevant);
    const tool = buildGetKnowledgeTool(knowledge) as any;

    const result = await tool.execute({ query: 'توصيل' });

    expect(result.entries[0]).not.toHaveProperty('product_id');
    expect(result.entries[0].category).toBe('shipping');
  });

  it('returns empty entries array when getRelevant returns []', async () => {
    const getRelevant = jest.fn().mockResolvedValue([]);
    const knowledge = makeKnowledgeMock(getRelevant);
    const tool = buildGetKnowledgeTool(knowledge) as any;

    const result = await tool.execute({});

    expect(result).toEqual({ entries: [] });
  });

  it('maps multiple entries preserving order', async () => {
    const e1 = makeEntry({ id: 'k1', productId: null, category: 'faq' });
    const e2 = makeEntry({
      id: 'k2',
      productId: 'p5',
      category: 'product_info',
    });
    const getRelevant = jest.fn().mockResolvedValue([e1, e2]);
    const knowledge = makeKnowledgeMock(getRelevant);
    const tool = buildGetKnowledgeTool(knowledge) as any;

    const result = await tool.execute({ query: 'مقاسات' });

    expect(result.entries[0].id).toBe('k1');
    expect(result.entries[0]).not.toHaveProperty('product_id');
    expect(result.entries[1].id).toBe('k2');
    expect(result.entries[1].product_id).toBe('p5');
  });
});
