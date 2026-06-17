/**
 * Tests for buildCaptureOrderTool.
 *
 * This is a WRITE tool. Key design rules under test:
 *  - conversationId comes ONLY from requestContext, never from tool input.
 *  - All items are availability-checked BEFORE any order is written.
 *  - total is computed via sumJodLineTotals (integer arithmetic, never float).
 *  - address is flattened from structured → Arabic-comma-joined string.
 *  - The inputSchema must NOT expose conversationId/psid fields.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildCaptureOrderTool } from '../capture-order.tool';
import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';

// ---------------------------------------------------------------------------
// Fake requestContext helper
// ---------------------------------------------------------------------------

function ctx(vals: Record<string, string>) {
  return {
    requestContext: { get: (k: string) => vals[k] },
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeProductsMock(checkAvailabilityImpl: jest.Mock): ProductsService {
  return {
    checkAvailability: checkAvailabilityImpl,
  } as unknown as ProductsService;
}

function makeOrdersMock(createCodDraftImpl: jest.Mock): OrdersService {
  return {
    createCodDraft: createCodDraftImpl,
  } as unknown as OrdersService;
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const HAPPY_AVAIL = {
  available: true,
  product: { name: 'A', priceJod: '45.000' },
};

const HAPPY_ORDER = {
  order: { id: 'o1', status: 'draft' },
  items: [],
};

const HAPPY_INPUT = {
  items: [{ product_id: 'p1', quantity: 2 }],
  phone: '079',
  address: { city: 'عمان' },
};

const HAPPY_CTX = ctx({ conversationId: 'conv-1', psid: 'psid-1' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCaptureOrderTool', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('calls checkAvailability then createCodDraft with correct shape', async () => {
      const checkAvailability = jest.fn().mockResolvedValue(HAPPY_AVAIL);
      const createCodDraft = jest.fn().mockResolvedValue(HAPPY_ORDER);
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      const result = await tool.execute(HAPPY_INPUT, HAPPY_CTX);

      // conversationId from requestContext
      expect(createCodDraft).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' }),
      );

      // items mapping: product_id→productId, quantity→qty, size→undefined
      expect(createCodDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ productId: 'p1', size: undefined, qty: 2 }],
        }),
      );

      // address is flattened to a string
      const callArg = createCodDraft.mock.calls[0][0];
      expect(typeof callArg.address).toBe('string');
      expect(callArg.address).toContain('عمان');
    });

    it('returns order_id, total (45×2=90.000), currency, and status', async () => {
      const checkAvailability = jest.fn().mockResolvedValue(HAPPY_AVAIL);
      const createCodDraft = jest.fn().mockResolvedValue(HAPPY_ORDER);
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      const result = await tool.execute(HAPPY_INPUT, HAPPY_CTX);

      expect(result).toEqual({
        order_id: 'o1',
        total: '90.000', // 45.000 × 2
        currency: 'JOD',
        status: 'draft',
      });
    });

    it('total is a string, not a number', async () => {
      const checkAvailability = jest.fn().mockResolvedValue(HAPPY_AVAIL);
      const createCodDraft = jest.fn().mockResolvedValue(HAPPY_ORDER);
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      const result = await tool.execute(HAPPY_INPUT, HAPPY_CTX);

      expect(typeof result.total).toBe('string');
    });

    it('flattens a full address including area/street/details', async () => {
      const checkAvailability = jest.fn().mockResolvedValue(HAPPY_AVAIL);
      const createCodDraft = jest.fn().mockResolvedValue(HAPPY_ORDER);
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await tool.execute(
        {
          ...HAPPY_INPUT,
          address: {
            city: 'عمان',
            area: 'الصويفية',
            street: 'شارع الثقافة',
            details: 'شقة 5',
          },
        },
        HAPPY_CTX,
      );

      const flatAddress = createCodDraft.mock.calls[0][0].address as string;
      expect(flatAddress).toContain('عمان');
      expect(flatAddress).toContain('الصويفية');
      expect(flatAddress).toContain('شارع الثقافة');
      expect(flatAddress).toContain('شقة 5');
    });

    it('checkAvailability is called once per item before createCodDraft', async () => {
      const checkAvailability = jest.fn().mockResolvedValue({
        available: true,
        product: { name: 'B', priceJod: '30.000' },
      });
      const createCodDraft = jest.fn().mockResolvedValue({
        order: { id: 'o2', status: 'draft' },
        items: [],
      });
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await tool.execute(
        {
          items: [
            { product_id: 'p1', quantity: 1 },
            { product_id: 'p2', quantity: 3 },
          ],
          phone: '079',
          address: { city: 'إربد' },
        },
        HAPPY_CTX,
      );

      expect(checkAvailability).toHaveBeenCalledTimes(2);
      expect(checkAvailability).toHaveBeenNthCalledWith(1, 'p1', undefined);
      expect(checkAvailability).toHaveBeenNthCalledWith(2, 'p2', undefined);
    });
  });

  // -------------------------------------------------------------------------
  // Identity absent
  // -------------------------------------------------------------------------
  describe('identity absent', () => {
    it('rejects when conversationId is missing from requestContext', async () => {
      const checkAvailability = jest.fn();
      const createCodDraft = jest.fn();
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await expect(
        tool.execute(HAPPY_INPUT, ctx({})),
      ).rejects.toThrow();

      expect(createCodDraft).not.toHaveBeenCalled();
    });

    it('rejects when no context is passed at all', async () => {
      const checkAvailability = jest.fn();
      const createCodDraft = jest.fn();
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await expect(tool.execute(HAPPY_INPUT)).rejects.toThrow();

      expect(createCodDraft).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Unavailable item
  // -------------------------------------------------------------------------
  describe('unavailable item', () => {
    it('rejects when checkAvailability returns available:false', async () => {
      const checkAvailability = jest.fn().mockResolvedValue({
        available: false,
        inStockSizes: [],
        product: { name: 'نافد', priceJod: '45.000' },
      });
      const createCodDraft = jest.fn();
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await expect(
        tool.execute(HAPPY_INPUT, HAPPY_CTX),
      ).rejects.toThrow();

      expect(createCodDraft).not.toHaveBeenCalled();
    });

    it('rejects when checkAvailability returns available:false without a product', async () => {
      const checkAvailability = jest.fn().mockResolvedValue({
        available: false,
        inStockSizes: [],
      });
      const createCodDraft = jest.fn();
      const tool = buildCaptureOrderTool(
        makeProductsMock(checkAvailability),
        makeOrdersMock(createCodDraft),
      ) as any;

      await expect(
        tool.execute(HAPPY_INPUT, HAPPY_CTX),
      ).rejects.toThrow();

      expect(createCodDraft).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Input schema — no identity fields exposed to the agent
  // -------------------------------------------------------------------------
  describe('inputSchema', () => {
    it('has items, customer_name, phone, and address keys', () => {
      const tool = buildCaptureOrderTool(
        makeProductsMock(jest.fn()),
        makeOrdersMock(jest.fn()),
      ) as any;

      const keys = Object.keys(tool.inputSchema.shape);
      expect(keys).toEqual(
        expect.arrayContaining(['items', 'customer_name', 'phone', 'address']),
      );
    });

    it('does NOT have conversationId or psid keys', () => {
      const tool = buildCaptureOrderTool(
        makeProductsMock(jest.fn()),
        makeOrdersMock(jest.fn()),
      ) as any;

      const keys = Object.keys(tool.inputSchema.shape);
      expect(keys).not.toContain('conversationId');
      expect(keys).not.toContain('psid');
    });
  });
});
