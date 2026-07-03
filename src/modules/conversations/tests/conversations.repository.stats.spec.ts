/**
 * Unit tests for ConversationsRepository.dashboardStats — chainable Drizzle
 * mock (same technique as conversations.repository.spec): first select()
 * resolves the GROUP BY ai_state rows, second select() the escalated count.
 */

import { ConversationsRepository } from '../conversations.repository';
import type { Database } from '@/core/database/drizzle';

function makeChain(result: unknown) {
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    groupBy: jest.fn(() => chain),
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  return chain;
}

function makeRepo(
  stateRows: unknown[],
  escalated: number,
): ConversationsRepository {
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(makeChain(stateRows))
      .mockReturnValueOnce(makeChain([{ value: escalated }])),
  };
  return new ConversationsRepository(db as unknown as Database);
}

describe('ConversationsRepository.dashboardStats', () => {
  it('zero-fills missing states, sums the total, and carries the escalated count', async () => {
    const repo = makeRepo(
      [
        { state: 'bot', value: 20 },
        { state: 'human', value: 3 },
      ],
      7,
    );

    const stats = await repo.dashboardStats();

    expect(stats).toEqual({
      total: 23,
      byState: { bot: 20, human: 3, paused: 0 },
      escalated: 7,
    });
  });

  it('coerces string counts from the driver into numbers', async () => {
    const repo = makeRepo([{ state: 'paused', value: '4' }], 0);

    const stats = await repo.dashboardStats();

    expect(stats.total).toBe(4);
    expect(stats.byState.paused).toBe(4);
    expect(stats.escalated).toBe(0);
  });
});
