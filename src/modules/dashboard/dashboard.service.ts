/**
 * DashboardService — composes the overview aggregates from the domain
 * services (never their repositories: cross-domain access goes through the
 * exported service, the single sanctioned channel). Each domain computes its
 * own numbers in SQL; this layer only fans out and assembles the envelope.
 */

import { Injectable } from '@nestjs/common';
import { ConversationsService } from '@/modules/conversations/conversations.service';
import { OrdersService } from '@/modules/orders/orders.service';
import { ProductsService } from '@/modules/products/products.service';
import type { DashboardStats } from './dto/dashboard-stats.dto';

/**
 * Window of the orders-per-day chart. Mirrors the frontend's 7-day frame
 * (`lib/dashboard.ts`), which labels days with ar-JO weekday names.
 */
const CHART_DAYS = 7;

/**
 * Staff think in Jordan wall-clock days (the brand and its operators are in
 * Amman), so daily buckets are cut on this zone — NOT UTC and NOT the server's
 * locale. Matches the frontend's local-midnight bucketing for Amman staff.
 */
const DASHBOARD_TIME_ZONE = 'Asia/Amman';

@Injectable()
export class DashboardService {
  constructor(
    private readonly products: ProductsService,
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
  ) {}

  /** All overview aggregates in one parallel fan-out (five cheap SQL counts). */
  async getStats(): Promise<DashboardStats> {
    const [productsTotal, productsPublished, orders, conversations] =
      await Promise.all([
        this.products.countProducts(),
        this.products.countProducts({ isPublished: true }),
        this.orders.dashboardStats(CHART_DAYS, DASHBOARD_TIME_ZONE),
        this.conversations.dashboardStats(),
      ]);

    return {
      products: { total: productsTotal, published: productsPublished },
      orders,
      conversations,
    };
  }
}
