import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { ListOptions } from '@/common/types/query';
import { OrdersRepository, type NewOrderItemInput } from './orders.repository';
import {
  ORDER_STATUSES,
  type NewOrder,
  type Order,
} from './entities/order.entity';
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

  create(input: NewOrder): Promise<Order> {
    if (input.status !== undefined) {
      this.assertValidStatus(input.status);
    }
    return this.repo.insert(input);
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

  /** Attach line items to an existing order. */
  createItems(
    orderId: string,
    items: NewOrderItemInput[],
  ): Promise<OrderItem[]> {
    return this.repo.insertItems(orderId, items);
  }

  listItems(orderId: string): Promise<OrderItem[]> {
    return this.repo.listItemsByOrder(orderId);
  }
}
