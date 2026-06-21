import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import { orders, type NewOrder, type Order } from './entities/order.entity';
import {
  orderItems,
  type NewOrderItem,
  type OrderItem,
} from './entities/order-item.entity';

/** A line item without its order id — the repository fills `orderId` in. */
export type NewOrderItemInput = Omit<NewOrderItem, 'orderId'>;

/**
 * Sole owner of orders + order_items SQL (the COD runtime tables the agent
 * writes). Query-builder only. Money on the catalog side is numeric/string; this
 * layer stores line references and quantities, never float math.
 */
@Injectable()
export class OrdersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // --- orders ---

  async list(opts: ListOptions = {}): Promise<Order[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(orders)
      .orderBy(direction(orders.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findById(id: string): Promise<Order | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    return row;
  }

  async listByConversation(conversationId: string): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.conversationId, conversationId))
      .orderBy(desc(orders.createdAt));
  }

  /**
   * Returns the most-recent open draft for a conversation, or undefined when
   * none exists. Used for idempotent re-capture: re-submitting the same order
   * for an active conversation returns the existing draft rather than inserting
   * a duplicate.
   */
  async findOpenDraftByConversation(
    conversationId: string,
  ): Promise<Order | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.conversationId, conversationId),
          eq(orders.status, 'draft'),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(1);
    return row;
  }

  async insert(input: NewOrder): Promise<Order> {
    const [row] = await this.db.insert(orders).values(input).returning();
    return row;
  }

  async updateStatus(id: string, status: string): Promise<Order | undefined> {
    const [row] = await this.db
      .update(orders)
      .set({ status })
      .where(eq(orders.id, id))
      .returning();
    return row;
  }

  // --- order_items ---

  /** Insert all line items for an order in one statement; [] is a no-op. */
  async insertItems(
    orderId: string,
    items: NewOrderItemInput[],
  ): Promise<OrderItem[]> {
    if (items.length === 0) {
      return [];
    }
    return this.db
      .insert(orderItems)
      .values(items.map((item) => ({ ...item, orderId })))
      .returning();
  }

  async listItemsByOrder(orderId: string): Promise<OrderItem[]> {
    return this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id));
  }

  /**
   * Atomically insert an order and its line items inside one transaction, so a
   * draft is never left with a header but no items (or vice versa).
   */
  async createWithItems(
    order: NewOrder,
    items: NewOrderItemInput[],
  ): Promise<{ order: Order; items: OrderItem[] }> {
    return this.db.transaction(async (tx) => {
      const [createdOrder] = await tx.insert(orders).values(order).returning();
      const createdItems =
        items.length > 0
          ? await tx
              .insert(orderItems)
              .values(
                items.map((item) => ({ ...item, orderId: createdOrder.id })),
              )
              .returning()
          : [];
      return { order: createdOrder, items: createdItems };
    });
  }
}
