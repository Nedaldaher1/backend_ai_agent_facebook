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
   * none exists. Used so a re-capture edits the conversation's existing open
   * draft in place (one editable cart per conversation) instead of inserting a
   * duplicate order. The status is re-checked under a row lock inside
   * replaceDraftContents before the draft is mutated.
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

  /**
   * Overwrite the contents of an OPEN DRAFT in one transaction. Under a row lock
   * it re-checks the order is still a draft, then drops its line items, inserts
   * the new ones, and updates the header totals/destination (same id;
   * status/source/conversationId/createdAt untouched). Returns null when the row
   * is no longer an open draft — e.g. an admin confirmed/canceled it between the
   * lookup and here — so the caller inserts a fresh order instead of clobbering a
   * committed one (the destructive delete below must never touch a non-draft).
   *
   * Reached by the agent re-capture path, and by POST /admin/orders when a
   * conversationId that already has an open draft is supplied; in both cases the
   * still-open cart is edited in place rather than duplicated.
   */
  async replaceDraftContents(
    orderId: string,
    header: Pick<
      NewOrder,
      'phone' | 'address' | 'unifiedSize' | 'subtotal' | 'deliveryFee' | 'total'
    >,
    items: NewOrderItemInput[],
  ): Promise<{ order: Order; items: OrderItem[] } | null> {
    return this.db.transaction(async (tx) => {
      // Lock the row and re-assert it is still an open draft; a concurrent admin
      // confirm/cancel must not be clobbered by the delete/overwrite below.
      const [locked] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
        .for('update');
      if (!locked || locked.status !== 'draft') {
        return null;
      }

      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
      const createdItems =
        items.length > 0
          ? await tx
              .insert(orderItems)
              .values(items.map((item) => ({ ...item, orderId })))
              .returning()
          : [];
      const [order] = await tx
        .update(orders)
        .set(header)
        .where(eq(orders.id, orderId))
        .returning();
      return { order, items: createdItems };
    });
  }
}
