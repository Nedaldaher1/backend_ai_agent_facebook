import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from '../orders.service';
import type { OrdersRepository } from '../orders.repository';
import { ORDER_STATUSES } from '../entities/order.entity';

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

  it('createItems with items calls the repo', async () => {
    const item = {
      productId: 'p1',
      quantity: 2,
      unitPriceJod: '45.000',
      selectedSize: 'M',
    };
    insertItems.mockResolvedValue([{ ...item, orderId: 'o1', id: 'i1' }]);

    const result = await service.createItems('o1', [item]);

    expect(insertItems).toHaveBeenCalledWith('o1', [item]);
    expect(result).toHaveLength(1);
  });
});
