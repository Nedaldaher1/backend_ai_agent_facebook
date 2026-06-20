/**
 * Tests for buildCaptureOrderTool (thin write tool).
 *
 * Key design rules under test:
 *  - conversationId comes ONLY from requestContext, never from tool input.
 *  - `source` is derived from the channel in requestContext, never from input.
 *  - The tool delegates ALL business logic to OrdersService.captureCodOrder and
 *    maps its structured confirmation to the agent-facing snake_case output.
 *  - The input schema exposes NO identity fields and NO price/total fields — the
 *    LLM cannot set money.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildCaptureOrderTool } from '../capture-order.tool';
import type { OrdersService } from '@/modules/orders/orders.service';

// --- helpers ---------------------------------------------------------------

function ctx(vals: Record<string, string>) {
  return { requestContext: { get: (k: string) => vals[k] } };
}

function makeOrdersMock(captureImpl: jest.Mock): OrdersService {
  return { captureCodOrder: captureImpl } as unknown as OrdersService;
}

// --- shared data -----------------------------------------------------------

const CONFIRMATION = {
  orderId: 'o1',
  status: 'draft',
  source: 'messenger',
  phone: '+962791234567',
  address: 'عمّان، الصويفية، شارع الثقافة',
  lines: [
    {
      productId: 'p1',
      storageKey: 'img-1.jpg',
      productName: 'عباية كلاسيك',
      colorName: 'أسود',
      size: 'M',
      quantity: 2,
      unitPrice: '45.000',
      lineTotal: '90.000',
    },
  ],
  subtotal: '90.000',
  deliveryFee: '2.000',
  total: '92.000',
  currency: 'JOD' as const,
};

const HAPPY_RESULT = { order: { id: 'o1' }, items: [], confirmation: CONFIRMATION };

const HAPPY_INPUT = {
  items: [{ product_id: 'p1', storage_key: 'img-1.jpg', size: 'M', quantity: 2 }],
  phone: '0791234567',
  address: 'عمّان، الصويفية، شارع الثقافة',
};

const HAPPY_CTX = ctx({ conversationId: 'conv-1', channel: 'messenger' });

// --- tests -----------------------------------------------------------------

describe('buildCaptureOrderTool', () => {
  describe('delegation + mapping', () => {
    it('calls captureCodOrder with identity from context and mapped input', async () => {
      const capture = jest.fn().mockResolvedValue(HAPPY_RESULT);
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      await tool.execute(HAPPY_INPUT, HAPPY_CTX);

      expect(capture).toHaveBeenCalledWith({
        conversationId: 'conv-1', // from requestContext, not input
        source: 'messenger', // from channel
        phone: '0791234567',
        address: 'عمّان، الصويفية، شارع الثقافة',
        unifiedSize: undefined,
        items: [{ productId: 'p1', storageKey: 'img-1.jpg', size: 'M', qty: 2 }],
      });
    });

    it('maps the service confirmation to the snake_case output', async () => {
      const capture = jest.fn().mockResolvedValue(HAPPY_RESULT);
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      const result = await tool.execute(HAPPY_INPUT, HAPPY_CTX);

      expect(result).toEqual({
        order_id: 'o1',
        status: 'draft',
        source: 'messenger',
        phone: '+962791234567',
        address: 'عمّان، الصويفية، شارع الثقافة',
        items: [
          {
            product_id: 'p1',
            product_name: 'عباية كلاسيك',
            color_name: 'أسود',
            size: 'M',
            quantity: 2,
            unit_price: '45.000',
            line_total: '90.000',
          },
        ],
        subtotal: '90.000',
        delivery_fee: '2.000',
        total: '92.000',
        currency: 'JOD',
      });
    });
  });

  describe('source from channel', () => {
    it('uses whatsapp when the channel is whatsapp', async () => {
      const capture = jest.fn().mockResolvedValue(HAPPY_RESULT);
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      await tool.execute(
        HAPPY_INPUT,
        ctx({ conversationId: 'conv-1', channel: 'whatsapp' }),
      );

      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'whatsapp' }),
      );
    });

    it('defaults to messenger when no channel is present', async () => {
      const capture = jest.fn().mockResolvedValue(HAPPY_RESULT);
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      await tool.execute(HAPPY_INPUT, ctx({ conversationId: 'conv-1' }));

      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'messenger' }),
      );
    });
  });

  describe('identity absent', () => {
    it('rejects when conversationId is missing from requestContext', async () => {
      const capture = jest.fn();
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      await expect(tool.execute(HAPPY_INPUT, ctx({}))).rejects.toThrow();
      expect(capture).not.toHaveBeenCalled();
    });

    it('rejects when no context is passed at all', async () => {
      const capture = jest.fn();
      const tool = buildCaptureOrderTool(makeOrdersMock(capture)) as any;

      await expect(tool.execute(HAPPY_INPUT)).rejects.toThrow();
      expect(capture).not.toHaveBeenCalled();
    });
  });

  describe('inputSchema — no identity, no price fields', () => {
    it('exposes the delivery/items fields the agent supplies', () => {
      const tool = buildCaptureOrderTool(makeOrdersMock(jest.fn())) as any;
      const keys = Object.keys(tool.inputSchema.shape);

      expect(keys).toEqual(
        expect.arrayContaining(['items', 'phone', 'address', 'unified_size']),
      );
    });

    it('does NOT expose identity, server-set, or dropped fields', () => {
      const tool = buildCaptureOrderTool(makeOrdersMock(jest.fn())) as any;
      const keys = Object.keys(tool.inputSchema.shape);

      expect(keys).not.toContain('conversationId');
      expect(keys).not.toContain('psid');
      expect(keys).not.toContain('source');
      expect(keys).not.toContain('governorate');
      expect(keys).not.toContain('customer_name');
    });

    it('does NOT let the agent supply prices or totals', () => {
      const tool = buildCaptureOrderTool(makeOrdersMock(jest.fn())) as any;
      const topKeys = Object.keys(tool.inputSchema.shape);
      expect(topKeys).not.toContain('subtotal');
      expect(topKeys).not.toContain('delivery_fee');
      expect(topKeys).not.toContain('total');

      const itemKeys = Object.keys(tool.inputSchema.shape.items.element.shape);
      expect(itemKeys).toEqual(
        expect.arrayContaining(['product_id', 'storage_key', 'size', 'quantity']),
      );
      expect(itemKeys).not.toContain('unit_price');
      expect(itemKeys).not.toContain('price');
      expect(itemKeys).not.toContain('line_total');
    });
  });
});
