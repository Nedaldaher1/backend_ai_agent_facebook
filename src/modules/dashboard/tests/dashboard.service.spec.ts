/**
 * Unit tests for DashboardService — the domain services are mocked; the
 * assertions cover the fan-out (each aggregate requested once, published
 * count filtered) and the assembled envelope shape.
 */

// ESM-only deps pulled in transitively through ProductsService — stub so the
// module graph loads under Jest (CJS), mirroring the other cross-domain specs.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { DashboardService } from '../dashboard.service';
import { dashboardStatsSchema } from '../dto/dashboard-stats.dto';
import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';

const ORDERS_STATS = {
  total: 12,
  byStatus: { draft: 4, confirmed: 5, fulfilled: 2, canceled: 1 },
  byDay: [
    { day: '2026-07-01', count: 3 },
    { day: '2026-07-03', count: 9 },
  ],
};

const CONVERSATIONS_STATS = {
  total: 30,
  byState: { bot: 25, human: 3, paused: 2 },
  escalated: 7,
};

function makeService() {
  const products = {
    countProducts: jest
      .fn()
      .mockImplementation((filter?: { isPublished?: boolean }) =>
        Promise.resolve(filter?.isPublished ? 40 : 55),
      ),
  } as unknown as ProductsService;
  const orders = {
    dashboardStats: jest.fn().mockResolvedValue(ORDERS_STATS),
  } as unknown as OrdersService;
  const conversations = {
    dashboardStats: jest.fn().mockResolvedValue(CONVERSATIONS_STATS),
  } as unknown as ConversationsService;

  return {
    service: new DashboardService(products, orders, conversations),
    products,
    orders,
    conversations,
  };
}

describe('DashboardService.getStats', () => {
  it('assembles all domain aggregates into one envelope', async () => {
    const { service } = makeService();

    const stats = await service.getStats();

    expect(stats).toEqual({
      products: { total: 55, published: 40 },
      orders: ORDERS_STATS,
      conversations: CONVERSATIONS_STATS,
    });
  });

  it('requests the published count with the isPublished filter', async () => {
    const { service, products } = makeService();

    await service.getStats();

    expect(products.countProducts).toHaveBeenCalledTimes(2);
    expect(products.countProducts).toHaveBeenCalledWith();
    expect(products.countProducts).toHaveBeenCalledWith({ isPublished: true });
  });

  it('asks for the 7-day chart window in the Amman time zone', async () => {
    const { service, orders } = makeService();

    await service.getStats();

    expect(orders.dashboardStats).toHaveBeenCalledWith(7, 'Asia/Amman');
  });

  it('produces an envelope that satisfies the response schema', async () => {
    const { service } = makeService();

    const stats = await service.getStats();

    expect(dashboardStatsSchema.safeParse(stats).success).toBe(true);
  });
});
