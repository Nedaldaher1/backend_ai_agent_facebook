// OrdersService imports ProductsService (DI), which pulls in StorageService →
// flydrive (ESM-only). Stub the flydrive entry points so Jest can load the chain;
// ProductsService itself is fully mocked below, so the real drivers are unused.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import type { OrdersRepository } from '../orders.repository';
import type { ProductsService } from '@/modules/products/products.service';
import { ORDER_STATUSES } from '../entities/order.entity';
import { OrderCaptureError } from '../order-capture.error';

/** A real (v4) UUID — product_id is a uuid column, so the schema enforces format. */
const PRODUCT_ID = '3f1a9b2c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1',
  conversationId: null,
  phone: '0791234567',
  address: 'عمان، الأردن',
  status: 'draft',
  createdAt: new Date(),
  ...overrides,
});

/** A published, in-stock catalog product as ProductsService.checkAvailability returns it. */
const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  name: 'عباية كلاسيك',
  priceJod: '45.000',
  sizes: ['S', 'M', 'L'],
  imageUrls: ['img-1.jpg', 'img-2.jpg'],
  stockStatus: 'in_stock',
  isPublished: true,
  ...overrides,
});

describe('OrdersService', () => {
  const list = jest.fn();
  const findById = jest.fn();
  const listByConversation = jest.fn();
  const insert = jest.fn();
  const updateStatus = jest.fn();
  const insertItems = jest.fn();
  const listItemsByOrder = jest.fn();
  const createWithItems = jest.fn();

  const repo = {
    list,
    findById,
    listByConversation,
    insert,
    updateStatus,
    insertItems,
    listItemsByOrder,
    createWithItems,
  } as unknown as OrdersRepository;

  const checkAvailability = jest.fn();
  const getImageColorName = jest.fn();
  const products = {
    checkAvailability,
    getImageColorName,
  } as unknown as ProductsService;

  const service = new OrdersService(repo, products);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- updateStatus enum guard ---

  it.each(ORDER_STATUSES)(
    'updateStatus succeeds for valid status "%s"',
    async (status) => {
      const order = makeOrder({ id: 'o1', status });
      findById.mockResolvedValue(order);
      updateStatus.mockResolvedValue(order);

      const result = await service.updateStatus('o1', status);

      expect(updateStatus).toHaveBeenCalledWith('o1', status);
      expect(result.status).toBe(status);
    },
  );

  it('updateStatus throws BadRequestException for an invalid status', async () => {
    await expect(service.updateStatus('o1', 'shipped')).rejects.toThrow(
      BadRequestException,
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('updateStatus throws BadRequestException for an empty string', async () => {
    await expect(service.updateStatus('o1', '')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('updateStatus throws NotFoundException when the order does not exist', async () => {
    updateStatus.mockResolvedValue(undefined);

    await expect(service.updateStatus('ghost', 'confirmed')).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- create status validation ---

  it('create rejects an invalid status', () => {
    expect(() => service.create({ status: 'invalid_status' })).toThrow(
      BadRequestException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('create accepts a valid status', () => {
    const order = makeOrder({ status: 'draft' });
    insert.mockResolvedValue(order);

    expect(() => service.create({ status: 'draft' })).not.toThrow();
    expect(insert).toHaveBeenCalled();
  });

  it('create proceeds without a status field (uses DB default)', () => {
    const order = makeOrder();
    insert.mockResolvedValue(order);

    expect(() => service.create({})).not.toThrow();
    expect(insert).toHaveBeenCalledWith({});
  });

  // --- createItems with empty array ---

  it('createItems with an empty array returns [] without calling insertItems', async () => {
    insertItems.mockResolvedValue([]);

    const result = await service.createItems('o1', []);

    // The repo's insertItems is a no-op for [], but service still delegates
    expect(result).toEqual([]);
  });

  it('createItems with items validates each item then calls the repo', async () => {
    // Field names match the order_items table; storage_key is required (NOT NULL).
    const item = {
      productId: PRODUCT_ID,
      storageKey: 'img-1.jpg',
      size: 'M',
      qty: 2,
    };
    insertItems.mockResolvedValue([{ ...item, orderId: 'o1', id: 'i1' }]);

    const result = await service.createItems('o1', [item]);

    expect(insertItems).toHaveBeenCalledWith('o1', [item]);
    expect(result).toHaveLength(1);
  });

  it('createItems rejects an item carrying an unknown field', () => {
    expect(() =>
      // `unitPriceJod` is not a column; strict validation must reject it.
      service.createItems('o1', [
        { productId: PRODUCT_ID, qty: 1, unitPriceJod: '45.000' } as never,
      ]),
    ).toThrow(BadRequestException);
    expect(insertItems).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // captureCodOrder — full COD capture (agent write path)
  // -------------------------------------------------------------------------
  describe('captureCodOrder', () => {
    /** checkAvailability → published+available product; getImageColorName → color. */
    function mockCatalog(
      product: Record<string, unknown> = makeProduct(),
      color: string | null = 'أسود',
    ) {
      checkAvailability.mockResolvedValue({ available: true, product });
      getImageColorName.mockResolvedValue(color);
    }

    /** createWithItems echoes the header+items back as if persisted. */
    function mockPersist() {
      createWithItems.mockImplementation((order, items) =>
        Promise.resolve({
          order: { id: 'o1', ...order },
          items: items.map((it: Record<string, unknown>, i: number) => ({
            id: `i${i}`,
            orderId: 'o1',
            ...it,
          })),
        }),
      );
    }

    const baseInput = () => ({
      conversationId: 'conv-1',
      source: 'messenger' as const,
      phone: '0791234567',
      address: 'عمّان، الصويفية، شارع الثقافة، بناية 5',
      items: [
        { productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'M', qty: 2 },
      ],
    });

    it('persists a full order: normalized phone, snapshots, server-derived totals', async () => {
      mockCatalog();
      mockPersist();

      const result = await service.captureCodOrder(baseInput());

      // Header row written with normalized phone + structured destination.
      const [orderRow, itemRows] = createWithItems.mock.calls[0];
      expect(orderRow).toMatchObject({
        conversationId: 'conv-1',
        source: 'messenger',
        phone: '+962791234567', // normalized from 0791234567
        address: 'عمّان، الصويفية، شارع الثقافة، بناية 5',
        currency: 'JOD',
        status: 'draft',
      });
      // dropped fields must not be written
      expect(orderRow).not.toHaveProperty('governorate');
      expect(orderRow).not.toHaveProperty('customerName');
      // Money derived from catalog (45 × 2) + amman fee (2.000).
      expect(orderRow.subtotal).toBe('90.000');
      expect(orderRow.deliveryFee).toBe('2.000');
      expect(orderRow.total).toBe('92.000');

      // Line item snapshots model/image/size/qty + price/name/color.
      expect(itemRows).toEqual([
        {
          productId: PRODUCT_ID,
          storageKey: 'img-1.jpg',
          size: 'M',
          qty: 2,
          unitPrice: '45.000',
          lineTotal: '90.000',
          productName: 'عباية كلاسيك',
          colorName: 'أسود',
        },
      ]);

      // Structured confirmation echoes accurate numbers back to the agent.
      expect(result.confirmation).toMatchObject({
        orderId: 'o1',
        status: 'draft',
        source: 'messenger',
        phone: '+962791234567',
        address: 'عمّان، الصويفية، شارع الثقافة، بناية 5',
        subtotal: '90.000',
        deliveryFee: '2.000',
        total: '92.000',
        currency: 'JOD',
      });
      expect(result.confirmation.lines[0]).toMatchObject({
        productName: 'عباية كلاسيك',
        colorName: 'أسود',
        size: 'M',
        quantity: 2,
        unitPrice: '45.000',
        lineTotal: '90.000',
      });
    });

    it('overrides any LLM-supplied price with the catalog price', async () => {
      mockCatalog(makeProduct({ priceJod: '45.000' }));
      mockPersist();

      const input = baseInput();
      // Simulate a hallucinated price sneaking into the item — it must be ignored.
      (input.items[0] as Record<string, unknown>).unitPrice = '0.001';

      await service.captureCodOrder(input);

      const [, itemRows] = createWithItems.mock.calls[0];
      expect(itemRows[0].unitPrice).toBe('45.000');
      expect(itemRows[0].lineTotal).toBe('90.000');
    });

    it('honors per-item sizes (no unified size)', async () => {
      mockCatalog();
      mockPersist();

      const input = {
        ...baseInput(),
        items: [
          { productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'S', qty: 1 },
          { productId: PRODUCT_ID, storageKey: 'img-2.jpg', size: 'L', qty: 1 },
        ],
      };

      const result = await service.captureCodOrder(input);

      expect(result.confirmation.lines.map((l) => l.size)).toEqual(['S', 'L']);
    });

    it('applies unified_size to items with no explicit size', async () => {
      mockCatalog();
      mockPersist();

      const input = {
        ...baseInput(),
        unifiedSize: 'L',
        items: [
          // item 1 keeps its explicit size; item 2 falls back to unified 'L'.
          { productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'S', qty: 1 },
          { productId: PRODUCT_ID, storageKey: 'img-2.jpg', qty: 1 },
        ],
      };

      const result = await service.captureCodOrder(input);

      expect(result.confirmation.lines.map((l) => l.size)).toEqual(['S', 'L']);
    });

    it('auto-resolves a single-size (free-size) product', async () => {
      mockCatalog(makeProduct({ sizes: ['onesize'] }));
      mockPersist();

      const input = {
        ...baseInput(),
        items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', qty: 1 }],
      };

      const result = await service.captureCodOrder(input);

      expect(result.confirmation.lines[0].size).toBe('onesize');
    });

    it('allows a sizeless product (no sizes[]) with no size', async () => {
      mockCatalog(makeProduct({ sizes: [] }));
      mockPersist();

      const input = {
        ...baseInput(),
        items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', qty: 1 }],
      };

      const result = await service.captureCodOrder(input);

      expect(result.confirmation.lines[0].size).toBeNull();
    });

    it('applies the flat delivery fee regardless of the address', async () => {
      mockCatalog();
      mockPersist();

      const result = await service.captureCodOrder({
        ...baseInput(),
        address: 'العقبة، حي المطار، بناية 12',
      });

      expect(result.confirmation.deliveryFee).toBe('2.000');
      expect(result.confirmation.total).toBe('92.000'); // 90 + 2
    });

    it('sets source from the channel (whatsapp)', async () => {
      mockCatalog();
      mockPersist();

      const result = await service.captureCodOrder({
        ...baseInput(),
        source: 'whatsapp',
      });

      const [orderRow] = createWithItems.mock.calls[0];
      expect(orderRow.source).toBe('whatsapp');
      expect(result.confirmation.source).toBe('whatsapp');
    });

    // --- abort the whole order on any validation failure (no partial orders) ---

    it('rejects an invalid Jordanian phone and writes nothing', async () => {
      mockCatalog();
      mockPersist();

      await expect(
        service.captureCodOrder({ ...baseInput(), phone: '06123456' }),
      ).rejects.toThrow(/رقم الهاتف/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('throws a typed OrderCaptureError (not a generic Error) on grounding failure', async () => {
      // The admin route relies on this type to map grounding failures to 400.
      mockCatalog();
      mockPersist();

      await expect(
        service.captureCodOrder({ ...baseInput(), phone: '06123456' }),
      ).rejects.toBeInstanceOf(OrderCaptureError);
    });

    it('rejects an empty address', async () => {
      mockCatalog();
      mockPersist();

      await expect(
        service.captureCodOrder({ ...baseInput(), address: '   ' }),
      ).rejects.toThrow(/عنوان/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects an unknown / unpublished product', async () => {
      // checkAvailability returns no product for missing/unpublished.
      checkAvailability.mockResolvedValue({ available: false });
      mockPersist();

      await expect(service.captureCodOrder(baseInput())).rejects.toThrow();
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects an out-of-stock product', async () => {
      checkAvailability.mockResolvedValue({
        available: false,
        product: makeProduct({ stockStatus: 'out' }),
      });
      mockPersist();

      await expect(service.captureCodOrder(baseInput())).rejects.toThrow(
        /غير متوفر/,
      );
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects a size not in the product sizes[]', async () => {
      mockCatalog(makeProduct({ sizes: ['S', 'M', 'L'] }));
      mockPersist();

      await expect(
        service.captureCodOrder({
          ...baseInput(),
          items: [
            { productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'XXL', qty: 1 },
          ],
        }),
      ).rejects.toThrow(/المقاس/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects when a required size is missing (multi-size product, no size)', async () => {
      mockCatalog(makeProduct({ sizes: ['S', 'M', 'L'] }));
      mockPersist();

      await expect(
        service.captureCodOrder({
          ...baseInput(),
          items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', qty: 1 }],
        }),
      ).rejects.toThrow(/المقاس/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects a storage_key that does not belong to the product', async () => {
      mockCatalog(makeProduct({ imageUrls: ['img-1.jpg'] }));
      mockPersist();

      await expect(
        service.captureCodOrder({
          ...baseInput(),
          items: [
            { productId: PRODUCT_ID, storageKey: 'ghost.jpg', size: 'M', qty: 1 },
          ],
        }),
      ).rejects.toThrow(/الصورة/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rejects an empty items list', async () => {
      mockPersist();

      await expect(
        service.captureCodOrder({ ...baseInput(), items: [] }),
      ).rejects.toThrow();
      expect(createWithItems).not.toHaveBeenCalled();
    });
  });
});
