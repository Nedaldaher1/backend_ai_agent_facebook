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
  const replaceDraftContents = jest.fn();
  const findOpenDraftByConversation = jest.fn();

  const repo = {
    list,
    findById,
    listByConversation,
    insert,
    updateStatus,
    insertItems,
    listItemsByOrder,
    createWithItems,
    replaceDraftContents,
    findOpenDraftByConversation,
  } as unknown as OrdersRepository;

  const checkAvailability = jest.fn();
  const getImageColorName = jest.fn();
  const resolveOrderImageKeyByColor = jest.fn();
  const products = {
    checkAvailability,
    getImageColorName,
    resolveOrderImageKeyByColor,
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

    /** replaceDraftContents echoes the updated header+items as if persisted. */
    function mockReplace() {
      replaceDraftContents.mockImplementation(
        (orderId: string, header: Record<string, unknown>, items: unknown[]) =>
          Promise.resolve({
            order: {
              id: orderId,
              status: 'draft',
              source: 'messenger',
              ...header,
            },
            items: (items as Record<string, unknown>[]).map((it, i) => ({
              id: `i${i}`,
              orderId,
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

    beforeEach(() => {
      // Default: no existing draft (idempotency check returns undefined).
      findOpenDraftByConversation.mockResolvedValue(undefined);
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

    // --- re-capture edits the open draft in place (one cart per conversation) ---

    it('updates the existing open draft in place when a new capture differs (no duplicate insert)', async () => {
      mockCatalog();
      mockReplace();

      const existingOrder = makeOrder({
        id: 'o-existing',
        conversationId: 'conv-1',
        status: 'draft',
        source: 'messenger',
      });
      findOpenDraftByConversation.mockResolvedValue(existingOrder);

      // baseInput() resolves to size 'M', qty 2 → 90 + 2 delivery = 92.
      const result = await service.captureCodOrder(baseInput());

      // The open draft is edited in place; no duplicate order is inserted.
      expect(createWithItems).not.toHaveBeenCalled();
      expect(replaceDraftContents).toHaveBeenCalledTimes(1);

      // Called with the existing draft id, the freshly-derived header, and the
      // NEW items — never the stale ones.
      const [orderId, header, itemRows] = replaceDraftContents.mock.calls[0];
      expect(orderId).toBe('o-existing');
      expect(header).toMatchObject({
        phone: '+962791234567',
        subtotal: '90.000',
        deliveryFee: '2.000',
        total: '92.000',
      });
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

      // Confirmation keeps the same order id but reflects the new contents.
      expect(result.order.id).toBe('o-existing');
      expect(result.confirmation.orderId).toBe('o-existing');
      expect(result.confirmation.total).toBe('92.000');
      expect(result.confirmation.lines[0].size).toBe('M');
      expect(result.confirmation.lines[0].quantity).toBe(2);
    });

    it('regression: a revised order (new colours + size) overwrites the stale draft', async () => {
      // Mirrors the field report: an old draft (أسود/بنفسجي, size 1) must NOT be
      // returned when the customer now wants أحمر/أخضر at size 2.
      const product = makeProduct({
        sizes: ['1', '2'],
        imageUrls: ['img-red.jpg', 'img-black.jpg', 'img-green.jpg'],
      });
      checkAvailability.mockResolvedValue({ available: true, product });
      resolveOrderImageKeyByColor.mockImplementation(
        (_id: string, color: string) =>
          Promise.resolve(
            color === 'أحمر'
              ? 'img-red.jpg'
              : color === 'أخضر'
                ? 'img-green.jpg'
                : null,
          ),
      );
      getImageColorName.mockImplementation((_id: string, key: string) =>
        Promise.resolve(key === 'img-red.jpg' ? 'أحمر' : 'أخضر'),
      );
      mockReplace();

      const staleDraft = makeOrder({
        id: 'o-stale',
        conversationId: 'conv-1',
        status: 'draft',
        source: 'messenger',
      });
      findOpenDraftByConversation.mockResolvedValue(staleDraft);

      const result = await service.captureCodOrder({
        conversationId: 'conv-1',
        source: 'messenger',
        phone: '0791234567',
        address: 'عمّان، الصويفية',
        items: [
          { productId: PRODUCT_ID, color: 'أحمر', size: '2', qty: 1 },
          { productId: PRODUCT_ID, color: 'أخضر', size: '2', qty: 1 },
        ],
      });

      expect(createWithItems).not.toHaveBeenCalled();
      expect(replaceDraftContents).toHaveBeenCalledTimes(1);

      // The lines reflect the NEW colours and size 2 — never the stale draft.
      expect(result.order.id).toBe('o-stale');
      expect(result.confirmation.lines).toHaveLength(2);
      expect(result.confirmation.lines.map((l) => l.size)).toEqual(['2', '2']);
      expect(result.confirmation.lines.map((l) => l.colorName)).toEqual([
        'أحمر',
        'أخضر',
      ]);
    });

    it('falls back to a new order when the open draft was confirmed concurrently (replace returns null)', async () => {
      mockCatalog();
      mockPersist();
      const existingOrder = makeOrder({
        id: 'o-existing',
        conversationId: 'conv-1',
        status: 'draft',
        source: 'messenger',
      });
      findOpenDraftByConversation.mockResolvedValue(existingOrder);
      // The row is no longer an open draft under the lock → replace bails (null).
      replaceDraftContents.mockResolvedValue(null);

      const result = await service.captureCodOrder(baseInput());

      expect(replaceDraftContents).toHaveBeenCalledTimes(1);
      expect(createWithItems).toHaveBeenCalledTimes(1);
      // Inserted as a fresh order (mockPersist → 'o1'), not the stale draft.
      expect(result.order.id).toBe('o1');
    });

    it('creates a new order when no open draft exists for the conversation', async () => {
      mockCatalog();
      mockPersist();
      // findOpenDraftByConversation already returns undefined via beforeEach

      await service.captureCodOrder(baseInput());

      expect(createWithItems).toHaveBeenCalledTimes(1);
    });

    it('does NOT call findOpenDraftByConversation when conversationId is null', async () => {
      mockCatalog();
      mockPersist();

      await service.captureCodOrder({ ...baseInput(), conversationId: null });

      expect(findOpenDraftByConversation).not.toHaveBeenCalled();
      expect(createWithItems).toHaveBeenCalledTimes(1);
    });

    // --- per-item colour resolution (color → variant image) ---

    /** Multi-colour product, one image per colour — the reported-bug shape. */
    const multiColorProduct = () =>
      makeProduct({
        name: 'عباية صيفي تطريز زهور',
        imageUrls: ['red.jpg', 'blue.jpg', 'green.jpg'],
        sizes: ['1', '2'],
      });

    it('maps each item to its chosen colour image (different colours → different images/colours)', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: multiColorProduct(),
        colors: ['أحمر', 'أزرق غامق', 'أخضر'],
      });
      resolveOrderImageKeyByColor.mockImplementation((_pid, color) =>
        Promise.resolve(
          color === 'أحمر'
            ? 'red.jpg'
            : color === 'أزرق غامق'
              ? 'blue.jpg'
              : null,
        ),
      );
      getImageColorName.mockImplementation((_pid, key) =>
        Promise.resolve(key === 'red.jpg' ? 'أحمر' : 'ازرق غامق'),
      );
      mockPersist();

      const result = await service.captureCodOrder({
        ...baseInput(),
        items: [
          { productId: PRODUCT_ID, color: 'أحمر', size: '1', qty: 1 },
          { productId: PRODUCT_ID, color: 'أزرق غامق', size: '2', qty: 1 },
        ],
      });

      const [, itemRows] = createWithItems.mock.calls[0];
      expect(
        itemRows.map((r: Record<string, unknown>) => r.storageKey),
      ).toEqual(['red.jpg', 'blue.jpg']);
      expect(
        itemRows.map((r: Record<string, unknown>) => r.colorName),
      ).toEqual(['أحمر', 'ازرق غامق']);
      expect(result.confirmation.lines.map((l) => l.colorName)).toEqual([
        'أحمر',
        'ازرق غامق',
      ]);
    });

    it('refuses (no primary-colour fallback) when the chosen colour is unavailable', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: multiColorProduct(),
        colors: ['أحمر', 'أزرق غامق', 'أخضر'],
      });
      resolveOrderImageKeyByColor.mockResolvedValue(null);
      mockPersist();

      await expect(
        service.captureCodOrder({
          ...baseInput(),
          items: [{ productId: PRODUCT_ID, color: 'ذهبي', size: '1', qty: 1 }],
        }),
      ).rejects.toThrow(/اللون "ذهبي" غير متوفر/);
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('lets colour take precedence over an explicit storage_key', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: multiColorProduct(),
        colors: ['أحمر', 'أزرق غامق'],
      });
      resolveOrderImageKeyByColor.mockResolvedValue('blue.jpg');
      getImageColorName.mockResolvedValue('ازرق غامق');
      mockPersist();

      await service.captureCodOrder({
        ...baseInput(),
        items: [
          // Agent also (wrongly) sent the primary red key — colour must win.
          {
            productId: PRODUCT_ID,
            color: 'أزرق غامق',
            storageKey: 'red.jpg',
            size: '1',
            qty: 1,
          },
        ],
      });

      const [, itemRows] = createWithItems.mock.calls[0];
      expect(itemRows[0].storageKey).toBe('blue.jpg');
      expect(resolveOrderImageKeyByColor).toHaveBeenCalledWith(
        PRODUCT_ID,
        'أزرق غامق',
      );
    });

    it('refuses a multi-image product when neither colour nor storage_key is given', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: multiColorProduct(),
        colors: ['أحمر', 'أزرق غامق'],
      });
      mockPersist();

      await expect(
        service.captureCodOrder({
          ...baseInput(),
          items: [{ productId: PRODUCT_ID, size: '1', qty: 1 }],
        }),
      ).rejects.toThrow(/يرجى تحديد لون/);
      expect(createWithItems).not.toHaveBeenCalled();
      expect(resolveOrderImageKeyByColor).not.toHaveBeenCalled();
    });

    it('uses the only image for a single-image product with no colour (back-compat)', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: makeProduct({ imageUrls: ['only.jpg'], sizes: ['M'] }),
      });
      getImageColorName.mockResolvedValue('أسود');
      mockPersist();

      const result = await service.captureCodOrder({
        ...baseInput(),
        items: [{ productId: PRODUCT_ID, size: 'M', qty: 1 }],
      });

      const [, itemRows] = createWithItems.mock.calls[0];
      expect(itemRows[0].storageKey).toBe('only.jpg');
      expect(result.confirmation.lines[0].colorName).toBe('أسود');
      expect(resolveOrderImageKeyByColor).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // captureCodOrderSafe — agent-safe wrapper
  // -------------------------------------------------------------------------
  describe('captureCodOrderSafe', () => {
    beforeEach(() => {
      findOpenDraftByConversation.mockResolvedValue(undefined);
    });

    it('returns { ok: true, confirmation } on success', async () => {
      checkAvailability.mockResolvedValue({
        available: true,
        product: makeProduct(),
      });
      getImageColorName.mockResolvedValue('أسود');
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

      const result = await service.captureCodOrderSafe({
        conversationId: 'conv-1',
        source: 'messenger',
        phone: '0791234567',
        address: 'عمّان، الصويفية',
        items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'M', qty: 1 }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.confirmation.orderId).toBe('o1');
        expect(result.confirmation.currency).toBe('JOD');
      }
    });

    it('returns { ok: false, reason } when an OrderCaptureError is thrown', async () => {
      // Invalid phone triggers OrderCaptureError
      const result = await service.captureCodOrderSafe({
        conversationId: 'conv-1',
        source: 'messenger',
        phone: '06-invalid',
        address: 'عمّان',
        items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'M', qty: 1 }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/رقم الهاتف/);
      }
      expect(createWithItems).not.toHaveBeenCalled();
    });

    it('rethrows non-OrderCaptureError exceptions (system errors)', async () => {
      const boom = new Error('db connection lost');
      // Simulate a system-level failure in the catalog read
      checkAvailability.mockRejectedValue(boom);

      await expect(
        service.captureCodOrderSafe({
          conversationId: 'conv-1',
          source: 'messenger',
          phone: '0791234567',
          address: 'عمّان',
          items: [{ productId: PRODUCT_ID, storageKey: 'img-1.jpg', size: 'M', qty: 1 }],
        }),
      ).rejects.toBe(boom);
    });
  });

  // -------------------------------------------------------------------------
  // getStatusForConversation — order status lookup (agent read path)
  // -------------------------------------------------------------------------
  describe('getStatusForConversation', () => {
    const CONV_ID = 'conv-abc';
    const OTHER_CONV_ID = 'conv-xyz';
    const ORDER_ID_1 = '11111111-1111-1111-1111-111111111111';
    const ORDER_ID_2 = '22222222-2222-2222-2222-222222222222';

    function makeOrderRow(
      overrides: Record<string, unknown> = {},
    ) {
      return {
        id: ORDER_ID_1,
        conversationId: CONV_ID,
        status: 'draft',
        total: '92.000',
        currency: 'JOD',
        createdAt: new Date(),
        source: 'messenger',
        phone: '+962791234567',
        address: 'عمّان',
        unifiedSize: null,
        subtotal: '90.000',
        deliveryFee: '2.000',
        ...overrides,
      };
    }

    function makeItemRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'item-1',
        orderId: ORDER_ID_1,
        productId: PRODUCT_ID,
        storageKey: 'img-1.jpg',
        size: 'M',
        qty: 1,
        unitPrice: '45.000',
        lineTotal: '45.000',
        productName: 'عباية كلاسيك',
        colorName: 'أسود',
        ...overrides,
      };
    }

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('(a) lists all orders for a conversation newest-first with correct Arabic labels and itemsSummary', async () => {
      const order1 = makeOrderRow({ id: ORDER_ID_1, status: 'confirmed' });
      const order2 = makeOrderRow({
        id: ORDER_ID_2,
        status: 'fulfilled',
        total: '47.000',
      });
      // newest-first — repo returns them in this order
      listByConversation.mockResolvedValue([order1, order2]);
      // items for order 1: one with colorName, one without
      listItemsByOrder
        .mockResolvedValueOnce([
          makeItemRow({ qty: 1, colorName: 'أسود' }),
          makeItemRow({ id: 'item-2', productName: 'عباية سهرة', colorName: null, qty: 2 }),
        ])
        // items for order 2: single item
        .mockResolvedValueOnce([
          makeItemRow({ productName: 'عباية سهرة', colorName: 'بنّي', qty: 1 }),
        ]);

      const result = await service.getStatusForConversation(CONV_ID);

      expect(result.orders).toHaveLength(2);

      // First order (confirmed)
      expect(result.orders[0]).toMatchObject({
        orderId: ORDER_ID_1,
        status: 'confirmed',
        statusLabelAr: 'تم تأكيد طلبك وهو قيد التجهيز',
        itemsSummary: 'عباية كلاسيك (أسود) ×1، عباية سهرة ×2',
        total: '92.000',
        currency: 'JOD',
      });

      // Second order (fulfilled)
      expect(result.orders[1]).toMatchObject({
        orderId: ORDER_ID_2,
        status: 'fulfilled',
        statusLabelAr: 'تم إخراج طلبك وهو في طريقه إليك',
        itemsSummary: 'عباية سهرة (بنّي) ×1',
        total: '47.000',
      });
    });

    it('(b) orderId belonging to the conversation → returns just that order', async () => {
      const order = makeOrderRow({ id: ORDER_ID_1, status: 'draft' });
      findById.mockResolvedValue(order);
      listItemsByOrder.mockResolvedValue([makeItemRow()]);

      const result = await service.getStatusForConversation(CONV_ID, ORDER_ID_1);

      expect(findById).toHaveBeenCalledWith(ORDER_ID_1);
      expect(listByConversation).not.toHaveBeenCalled();
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].orderId).toBe(ORDER_ID_1);
      expect(result.orders[0].statusLabelAr).toBe('طلبك مسجّل عنا وقيد المراجعة');
    });

    it('(c) orderId belonging to a DIFFERENT conversation → returns empty (security)', async () => {
      // The order exists but belongs to another conversation.
      const order = makeOrderRow({ id: ORDER_ID_1, conversationId: OTHER_CONV_ID });
      findById.mockResolvedValue(order);

      const result = await service.getStatusForConversation(CONV_ID, ORDER_ID_1);

      expect(result.orders).toEqual([]);
      expect(listItemsByOrder).not.toHaveBeenCalled();
    });

    it('(c) unknown orderId (findById returns undefined) → returns empty', async () => {
      findById.mockResolvedValue(undefined);

      const result = await service.getStatusForConversation(CONV_ID, ORDER_ID_1);

      expect(result.orders).toEqual([]);
      expect(listItemsByOrder).not.toHaveBeenCalled();
    });

    it('(d) no orders for the conversation → returns { orders: [] }', async () => {
      listByConversation.mockResolvedValue([]);

      const result = await service.getStatusForConversation(CONV_ID);

      expect(result).toEqual({ orders: [] });
      expect(listItemsByOrder).not.toHaveBeenCalled();
    });

    it('(e) maps every status to its correct Arabic label', async () => {
      const statuses: Array<{ status: string; expected: string }> = [
        { status: 'draft', expected: 'طلبك مسجّل عنا وقيد المراجعة' },
        { status: 'confirmed', expected: 'تم تأكيد طلبك وهو قيد التجهيز' },
        { status: 'fulfilled', expected: 'تم إخراج طلبك وهو في طريقه إليك' },
        { status: 'canceled', expected: 'طلبك ملغى' },
      ];

      for (const { status, expected } of statuses) {
        jest.clearAllMocks();
        const order = makeOrderRow({ status });
        findById.mockResolvedValue(order);
        listItemsByOrder.mockResolvedValue([]);

        const result = await service.getStatusForConversation(CONV_ID, ORDER_ID_1);

        expect(result.orders[0].statusLabelAr).toBe(expected);
      }
    });

    it('(e) itemsSummary uses colorName when present and omits it when null', async () => {
      const order = makeOrderRow({ status: 'draft' });
      findById.mockResolvedValue(order);
      listItemsByOrder.mockResolvedValue([
        makeItemRow({ productName: 'عباية A', colorName: 'أسود', qty: 1 }),
        makeItemRow({ id: 'item-2', productName: 'عباية B', colorName: null, qty: 3 }),
      ]);

      const result = await service.getStatusForConversation(CONV_ID, ORDER_ID_1);

      expect(result.orders[0].itemsSummary).toBe('عباية A (أسود) ×1، عباية B ×3');
    });
  });
});
