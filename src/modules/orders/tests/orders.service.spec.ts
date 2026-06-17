import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import type { OrdersRepository } from '../orders.repository';
import { ORDER_STATUSES } from '../entities/order.entity';

/** A real (v4) UUID — product_id is a uuid column, so the schema enforces format. */
const PRODUCT_ID = '3f1a9b2c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1',
  conversationId: null,
  customerName: 'فاطمة',
  phone: '0791234567',
  address: 'عمان، الأردن',
  status: 'draft',
  createdAt: new Date(),
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

  const repo = {
    list,
    findById,
    listByConversation,
    insert,
    updateStatus,
    insertItems,
    listItemsByOrder,
  } as unknown as OrdersRepository;

  const service = new OrdersService(repo);

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
    // Field names match the order_items table: productId (uuid), size, qty.
    const item = { productId: PRODUCT_ID, size: 'M', qty: 2 };
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
});
