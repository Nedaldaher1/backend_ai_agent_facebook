/**
 * Unit tests for OrdersAdminController. OrdersService is fully mocked so no
 * database is touched. Guards are NOT applied here — guard behaviour is covered
 * by the dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the orders → products service
// chain doesn't try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersAdminController } from '../orders-admin.controller';
import type { OrdersService } from '../orders.service';
import { OrderCaptureError } from '../order-capture.error';
import type { CreateOrderBody } from '../dto/order.dto';
import type { Order } from '../entities/order.entity';
import type { OrderItem } from '../entities/order-item.entity';

const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  id: 'O-1',
  conversationId: 'CONV-1',
  source: 'messenger',
  phone: '+962790000000',
  address: 'عمّان، الدوار السابع',
  unifiedSize: null,
  subtotal: '20.000',
  deliveryFee: '2.000',
  total: '22.000',
  currency: 'JOD',
  status: 'draft',
  createdAt: new Date(),
  ...overrides,
});

const makeItem = (overrides: Partial<OrderItem> = {}): OrderItem => ({
  id: 'OI-1',
  orderId: 'O-1',
  productId: 'P-1',
  storageKey: 'img-1',
  size: 'M',
  qty: 1,
  unitPrice: '20.000',
  lineTotal: '20.000',
  productName: 'عباية كلاسيك',
  colorName: 'أسود',
  ...overrides,
});

describe('OrdersAdminController', () => {
  const list = jest.fn();
  const getById = jest.fn();
  const listItems = jest.fn();
  const updateStatus = jest.fn();
  const captureCodOrder = jest.fn();
  const orders = {
    list,
    getById,
    listItems,
    updateStatus,
    captureCodOrder,
  } as unknown as OrdersService;

  const controller = new OrdersAdminController(orders);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list passes pagination + ordering through to orders.list', async () => {
    list.mockResolvedValue([makeOrder()]);

    await controller.list({ limit: 10, offset: 5, orderBy: 'asc' });

    expect(list).toHaveBeenCalledWith({ limit: 10, offset: 5, orderBy: 'asc' });
  });

  it('getOne composes the order with its line items', async () => {
    const order = makeOrder({ id: 'O-1' });
    const items = [makeItem({ id: 'OI-1' }), makeItem({ id: 'OI-2' })];
    getById.mockResolvedValue(order);
    listItems.mockResolvedValue(items);

    const result = await controller.getOne('O-1');

    expect(getById).toHaveBeenCalledWith('O-1');
    expect(listItems).toHaveBeenCalledWith('O-1');
    expect(result).toEqual({ ...order, items });
  });

  it('getOne propagates NotFoundException and never lists items', async () => {
    getById.mockRejectedValue(new NotFoundException('Order ghost not found'));

    await expect(controller.getOne('ghost')).rejects.toThrow(NotFoundException);
    expect(listItems).not.toHaveBeenCalled();
  });

  it('updateStatus delegates the new status to orders.updateStatus', async () => {
    const updated = makeOrder({ status: 'confirmed' });
    updateStatus.mockResolvedValue(updated);

    expect(await controller.updateStatus('O-1', { status: 'confirmed' })).toBe(
      updated,
    );
    expect(updateStatus).toHaveBeenCalledWith('O-1', 'confirmed');
  });

  it('updateStatus propagates NotFoundException for an unknown order', async () => {
    updateStatus.mockRejectedValue(
      new NotFoundException('Order ghost not found'),
    );

    await expect(
      controller.updateStatus('ghost', { status: 'confirmed' }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- POST /admin/orders (grounded create, reuses captureCodOrder) ---

  /** A minimal valid body as it looks AFTER zod parsing (qty defaulted). */
  const createBody = (): CreateOrderBody => ({
    phone: '0791234567',
    address: 'عمّان، الصويفية',
    items: [{ productId: 'P-1', storageKey: 'img-1', size: 'M', qty: 2 }],
  });

  it('create delegates to captureCodOrder and returns the order with its items', async () => {
    const order = makeOrder({ id: 'O-9' });
    const items = [makeItem({ id: 'OI-9', orderId: 'O-9' })];
    captureCodOrder.mockResolvedValue({ order, items, confirmation: {} });

    const result = await controller.create(createBody());

    expect(captureCodOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: null, // omitted → null (standalone admin order)
        source: 'messenger', // defaulted server-side
        phone: '0791234567',
        address: 'عمّان، الصويفية',
        items: [{ productId: 'P-1', storageKey: 'img-1', size: 'M', qty: 2 }],
      }),
    );
    expect(result).toEqual({ ...order, items });
  });

  it('create forwards conversationId and source when supplied', async () => {
    captureCodOrder.mockResolvedValue({
      order: makeOrder(),
      items: [],
      confirmation: {},
    });

    await controller.create({
      ...createBody(),
      conversationId: 'CONV-7',
      source: 'whatsapp',
    });

    expect(captureCodOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'CONV-7',
        source: 'whatsapp',
      }),
    );
  });

  it('create maps an OrderCaptureError to a 400 (Arabic message kept)', async () => {
    captureCodOrder.mockRejectedValue(
      new OrderCaptureError('رقم الهاتف غير صالح.'),
    );

    await expect(controller.create(createBody())).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.create(createBody())).rejects.toThrow(
      'رقم الهاتف غير صالح.',
    );
  });

  it('create rethrows an unexpected error unchanged (→ 500, not 400)', async () => {
    const boom = new Error('db down');
    captureCodOrder.mockRejectedValue(boom);

    await expect(controller.create(createBody())).rejects.toBe(boom);
  });
});
