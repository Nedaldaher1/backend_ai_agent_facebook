/**
 * Structural test for the tools barrel (buildSalesTools).
 *
 * Verifies that buildSalesTools returns exactly the ten expected tool keys,
 * in the correct order. This guards against accidental additions, removals,
 * or renames that would silently break the Agent constructor registration.
 *
 * @mastra/core/tools is mocked (same pattern as all other tool specs) so
 * Jest never loads the real ESM module. find_similar_by_image constructs its
 * tool at import time, which is why the mock must be hoisted via jest.mock.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

// flydrive is ESM-only; stub it so the product service import chain doesn't
// blow up under Jest (CJS). Same pattern as agent.service.spec.ts.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));

import { buildSalesTools } from '../index';
import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';

describe('buildSalesTools — tool registry', () => {
  it('returns exactly the ten expected tool keys in order', () => {
    const result = buildSalesTools({
      products: {} as unknown as ProductsService,
      orders: {} as unknown as OrdersService,
      conversations: {} as unknown as ConversationsService,
      knowledge: {} as unknown as KnowledgeService,
      sizing: { recommendSize: jest.fn() } as unknown as SizingService,
    });

    expect(Object.keys(result)).toEqual([
      'search_products',
      'check_availability',
      'get_product_media',
      'get_knowledge',
      'recommend_size',
      'get_product_for_order',
      'capture_order',
      'escalate_to_human',
      'find_similar_by_image',
      'get_order_status',
    ]);
  });
});
