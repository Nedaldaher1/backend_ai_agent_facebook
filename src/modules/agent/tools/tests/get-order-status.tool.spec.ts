/**
 * Tests for buildGetOrderStatusTool (thin read tool).
 *
 * Key design rules under test:
 *  - conversationId comes ONLY from requestContext, never from tool input.
 *  - When conversationId is absent the tool returns { found: false, orders: [] }
 *    and NEVER calls the service.
 *  - The tool delegates ALL business logic to OrdersService.getStatusForConversation
 *    and maps its OrderStatusView[] to the agent-facing snake_case output.
 *  - The tool never throws — structured empty result is returned on all failure paths.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildGetOrderStatusTool } from '../get-order-status.tool';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { OrderStatusView } from '@/modules/orders/orders.service';

// --- helpers ---------------------------------------------------------------

/** Build a minimal requestContext-shaped object. */
function ctx(vals: Record<string, string>) {
  return { requestContext: { get: (k: string) => vals[k] } };
}

/** Build a mock OrdersService that returns the given views from getStatusForConversation. */
function makeServiceMock(
  views: OrderStatusView[],
): OrdersService {
  return {
    getStatusForConversation: jest.fn().mockResolvedValue({ orders: views }),
  } as unknown as OrdersService;
}

// --- shared data -----------------------------------------------------------

const CONV_CTX = ctx({ conversationId: 'conv-123' });

const VIEW_WITH_COLOR: OrderStatusView = {
  orderId: 'order-1',
  status: 'confirmed',
  statusLabelAr: 'تم تأكيد طلبك وهو قيد التجهيز',
  itemsSummary: 'عباية كلاسيك (أسود) ×1',
  total: '92.000',
  currency: 'JOD',
};

const VIEW_EMPTY_ITEMS: OrderStatusView = {
  orderId: 'order-2',
  status: 'draft',
  statusLabelAr: 'طلبك مسجّل عنا وقيد المراجعة',
  itemsSummary: '',
  total: '47.000',
  currency: 'JOD',
};

// --- tests -----------------------------------------------------------------

describe('buildGetOrderStatusTool', () => {
  describe('no conversationId in context', () => {
    it('returns { found: false, orders: [] } when requestContext has no conversationId', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute({}, ctx({}));

      expect(result).toEqual({ found: false, orders: [] });
      expect(service.getStatusForConversation).not.toHaveBeenCalled();
    });

    it('returns { found: false, orders: [] } when no context is passed at all', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute({}, undefined);

      expect(result).toEqual({ found: false, orders: [] });
      expect(service.getStatusForConversation).not.toHaveBeenCalled();
    });
  });

  describe('with conversationId', () => {
    it('calls getStatusForConversation with conversationId and no orderId when order_id is absent', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      await tool.execute({}, CONV_CTX);

      expect(service.getStatusForConversation).toHaveBeenCalledWith(
        'conv-123',
        undefined,
      );
    });

    it('forwards order_id to the service when provided', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      await tool.execute(
        { order_id: '11111111-1111-1111-1111-111111111111' },
        CONV_CTX,
      );

      expect(service.getStatusForConversation).toHaveBeenCalledWith(
        'conv-123',
        '11111111-1111-1111-1111-111111111111',
      );
    });

    it('maps OrderStatusView camelCase keys to snake_case output fields', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute({}, CONV_CTX);

      expect(result).toEqual({
        found: true,
        orders: [
          {
            order_id: 'order-1',
            status: 'confirmed',
            status_label_ar: 'تم تأكيد طلبك وهو قيد التجهيز',
            items_summary: 'عباية كلاسيك (أسود) ×1',
            total: '92.000',
            currency: 'JOD',
          },
        ],
      });
    });

    it('returns found=true when service returns at least one order', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute({}, CONV_CTX);

      expect(result.found).toBe(true);
    });

    it('returns found=false when service returns an empty array (security: foreign order)', async () => {
      const service = makeServiceMock([]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute(
        { order_id: '11111111-1111-1111-1111-111111111111' },
        CONV_CTX,
      );

      expect(result).toEqual({ found: false, orders: [] });
    });

    it('maps multiple views correctly', async () => {
      const service = makeServiceMock([VIEW_WITH_COLOR, VIEW_EMPTY_ITEMS]);
      const tool = buildGetOrderStatusTool(service) as any;

      const result = await tool.execute({}, CONV_CTX);

      expect(result.found).toBe(true);
      expect(result.orders).toHaveLength(2);
      expect(result.orders[0].order_id).toBe('order-1');
      expect(result.orders[1].order_id).toBe('order-2');
      expect(result.orders[1].status_label_ar).toBe('طلبك مسجّل عنا وقيد المراجعة');
    });
  });
});
