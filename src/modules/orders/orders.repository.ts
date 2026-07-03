import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  orders,
  ORDER_STATUSES,
  type NewOrder,
  type Order,
} from './entities/order.entity';
import {
  orderItems,
  type NewOrderItem,
  type OrderItem,
} from './entities/order-item.entity';

/** A line item without its order id — the repository fills `orderId` in. */
export type NewOrderItemInput = Omit<NewOrderItem, 'orderId'>;

/** Derived union from the ORDER_STATUSES tuple; avoids re-declaring the enum. */
export type OrderStatusKey = (typeof ORDER_STATUSES)[number];

/** SQL-side aggregates for the admin dashboard (see dashboardStats). */
export interface OrderDashboardStats {
  total: number;
  byStatus: Record<OrderStatusKey, number>;
  /** Orders per local calendar day, `YYYY-MM-DD`, oldest first; empty days absent. */
  byDay: Array<{ day: string; count: number }>;
}

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

  /**
   * Dashboard aggregates, computed IN SQL so the admin panel never has to page
   * order rows client-side just to count them:
   *  - `byStatus` — one GROUP BY over the whole table (statuses missing from
   *    the result are filled with 0; `total` is their sum, no extra query).
   *  - `byDay`    — orders per LOCAL calendar day (`timeZone`) for the last
   *    `days` days, keyed `YYYY-MM-DD`. Days with no orders are absent; the
   *    caller/UI fills the frame. `created_at` is timestamptz, so a single
   *    `AT TIME ZONE` yields the staff-local wall-clock day.
   */
  async dashboardStats(
    days: number,
    timeZone: string,
  ): Promise<OrderDashboardStats> {
    const statusRows = await this.db
      .select({ status: orders.status, value: count() })
      .from(orders)
      .groupBy(orders.status);

    const byStatus = Object.fromEntries(
      ORDER_STATUSES.map((s) => [s, 0]),
    ) as Record<OrderStatusKey, number>;
    let total = 0;
    for (const row of statusRows) {
      const n = Number(row.value);
      total += n;
      if ((ORDER_STATUSES as readonly string[]).includes(row.status)) {
        byStatus[row.status as OrderStatusKey] = n;
      }
    }

    // GROUP/ORDER BY ordinal position (1 = the day expression): repeating the
    // expression would re-bind `timeZone` as a NEW parameter each time, and
    // Postgres cannot prove `$1 = $5` at parse time — it rejects the query
    // with "created_at must appear in the GROUP BY clause" (caught live).
    const dayExpr = sql<string>`(${orders.createdAt} at time zone ${timeZone})::date`;
    const dayRows = await this.db
      .select({ day: dayExpr, value: count() })
      .from(orders)
      .where(
        sql`(${orders.createdAt} at time zone ${timeZone}) >= date_trunc('day', now() at time zone ${timeZone}) - (${days - 1} * interval '1 day')`,
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // Raw sql`` columns carry no Drizzle mapper: node-postgres returns ::date
    // as a 'YYYY-MM-DD' string, but normalize defensively in case a driver
    // hands back a Date (same lesson as listConversationsWithPreview).
    const byDay = dayRows.map((r) => {
      const raw: unknown = r.day;
      return {
        day:
          raw instanceof Date
            ? raw.toISOString().slice(0, 10)
            : String(raw).slice(0, 10),
        count: Number(r.value),
      };
    });

    return { total, byStatus, byDay };
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
