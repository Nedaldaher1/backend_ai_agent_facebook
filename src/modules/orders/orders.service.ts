import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { ListOptions } from '@/common/types/query';
import {
  createOrderItemSchema,
  createOrderSchema,
  parseOrThrow,
  type CreateOrderInput,
  type CreateOrderItemInput,
} from '@/common/validation';
import { OrdersRepository } from './orders.repository';
import { ORDER_STATUSES, type Order } from './entities/order.entity';
import type { OrderItem } from './entities/order-item.entity';

/**
 * COD order-draft capture and lifecycle. The agent module calls this (never the
 * repository) to create drafts, attach line items, and advance status.
 */
@Injectable()
export class OrdersService {
  constructor(private readonly repo: OrdersRepository) {}

  // --- orders ---

  list(opts?: ListOptions): Promise<Order[]> {
    return this.repo.list(opts);
  }

  async getById(id: string): Promise<Order> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return row;
  }

  listByConversation(conversationId: string): Promise<Order[]> {
    return this.repo.listByConversation(conversationId);
  }

  create(input: CreateOrderInput): Promise<Order> {
    const data = parseOrThrow(createOrderSchema, input);
    return this.repo.insert(data);
  }

  async updateStatus(id: string, status: string): Promise<Order> {
    this.assertValidStatus(status);
    const row = await this.repo.updateStatus(id, status);
    if (!row) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return row;
  }

  /** Guard the free-form text column against values outside the status enum. */
  private assertValidStatus(status: string): void {
    if (!z.enum(ORDER_STATUSES).safeParse(status).success) {
      throw new BadRequestException(
        `Invalid order status "${status}"; allowed: ${ORDER_STATUSES.join(', ')}`,
      );
    }
  }

  // --- order_items ---

  /** Attach line items to an existing order; each item is validated. */
  createItems(
    orderId: string,
    items: CreateOrderItemInput[],
  ): Promise<OrderItem[]> {
    const data = items.map((item) => parseOrThrow(createOrderItemSchema, item));
    return this.repo.insertItems(orderId, data);
  }

  listItems(orderId: string): Promise<OrderItem[]> {
    return this.repo.listItemsByOrder(orderId);
  }

  /**
   * Capture a COD order draft from the agent. Validates each item via the
   * shared zod schema (same source of truth as the admin UI) then writes both
   * the order header and line items atomically via the repository.
   *
   * Called ONLY by the capture_order tool; never by the admin controllers.
   */
  async createCodDraft(input: {
    conversationId: string;
    customerName?: string;
    phone: string;
    address: string;
    items: { productId: string; size?: string; qty: number }[];
  }): Promise<{ order: Order; items: OrderItem[] }> {
    // Validate the order header using the shared schema.
    const orderData = parseOrThrow(createOrderSchema, {
      conversationId: input.conversationId,
      customerName: input.customerName,
      phone: input.phone,
      address: input.address,
      status: 'draft',
    });

    // Validate each line item using the shared schema.
    // Note: createOrderItemSchema omits `orderId` — the repo fills it in.
    const itemsData = input.items.map((item) =>
      parseOrThrow(createOrderItemSchema, {
        productId: item.productId,
        size: item.size,
        qty: item.qty,
      }),
    );

    return this.repo.createWithItems(orderData, itemsData);
  }
}
