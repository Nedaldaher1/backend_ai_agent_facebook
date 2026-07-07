/**
 * Unit tests for OrdersRepository.dashboardStats.
 *
 * The Drizzle client is mocked with a chainable, awaitable builder (same
 * technique as conversations.repository.spec): first select() resolves the
 * GROUP BY status rows, second select() the per-day rows. Covers:
 *  - zero-fill of statuses absent from the GROUP BY result + summed total;
 *  - day-key normalization: raw sql`` columns carry no Drizzle mapper, so the
 *    driver may return a 'YYYY-MM-DD' string OR a Date — both must normalize.
 */

import { OrdersRepository } from '../orders.repository';
import type { TenantDb } from '@/core/tenancy/tenant-db';

function makeChain(result: unknown) {
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    groupBy: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  return chain;
}

function makeRepo(statusRows: unknown[], dayRows: unknown[]): OrdersRepository {
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(makeChain(statusRows))
      .mockReturnValueOnce(makeChain(dayRows)),
  };
  const tenantDb = {
    tx: (fn: (db: unknown) => unknown) => fn(db),
  } as unknown as TenantDb;
  return new OrdersRepository(tenantDb);
}

describe('OrdersRepository.dashboardStats', () => {
  it('zero-fills missing statuses and sums the total', async () => {
    const repo = makeRepo(
      [
        { status: 'draft', value: 4 },
        { status: 'confirmed', value: 2 },
      ],
      [],
    );

    const stats = await repo.dashboardStats(7, 'Asia/Amman');

    expect(stats.total).toBe(6);
    expect(stats.byStatus).toEqual({
      draft: 4,
      confirmed: 2,
      fulfilled: 0,
      canceled: 0,
    });
    expect(stats.byDay).toEqual([]);
  });

  it('ignores an unknown status value without dropping it from the total', async () => {
    const repo = makeRepo(
      [
        { status: 'draft', value: 1 },
        { status: 'legacy-weird', value: 2 },
      ],
      [],
    );

    const stats = await repo.dashboardStats(7, 'Asia/Amman');

    expect(stats.total).toBe(3);
    expect(stats.byStatus.draft).toBe(1);
  });

  it('normalizes day keys returned as strings', async () => {
    const repo = makeRepo(
      [],
      [
        { day: '2026-07-01', value: 3 },
        { day: '2026-07-02', value: '5' }, // driver may return count as string
      ],
    );

    const stats = await repo.dashboardStats(7, 'Asia/Amman');

    expect(stats.byDay).toEqual([
      { day: '2026-07-01', count: 3 },
      { day: '2026-07-02', count: 5 },
    ]);
  });

  it('normalizes day keys returned as Date objects', async () => {
    const repo = makeRepo(
      [],
      [{ day: new Date('2026-07-03T00:00:00Z'), value: 2 }],
    );

    const stats = await repo.dashboardStats(7, 'Asia/Amman');

    expect(stats.byDay).toEqual([{ day: '2026-07-03', count: 2 }]);
  });
});
