/**
 * Regression tests for ConversationsRepository.listConversationsWithPreview.
 *
 * The last-message timestamp is fetched via a raw sql`` correlated subquery,
 * which carries no Drizzle column mapper. The node-postgres driver therefore
 * returns that column as a *string* (raw Postgres text), not a Date. The
 * repository must normalize it to a Date so the declared ConversationListRow
 * contract (lastMessageAt: Date | null) holds — otherwise downstream callers
 * crash on `.toISOString()` (the original bug).
 *
 * The Drizzle client is mocked with a chainable, awaitable builder; no real
 * database is touched.
 */

import { ConversationsRepository } from '../conversations.repository';
import type { Database } from '@/core/database/drizzle';

// A chainable query builder whose every step returns itself and which resolves
// (via `then`) to the supplied result when awaited — mirroring how Drizzle's
// builder is consumed in listConversationsWithPreview.
function makeChain(result: unknown) {
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    offset: jest.fn(() => chain),
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  return chain;
}

function makeRepo(rows: unknown[], total: number): ConversationsRepository {
  const db = {
    // First select() → data page; second select() → count query.
    select: jest
      .fn()
      .mockReturnValueOnce(makeChain(rows))
      .mockReturnValueOnce(makeChain([{ value: total }])),
  };
  return new ConversationsRepository(db as unknown as Database);
}

describe('ConversationsRepository.listConversationsWithPreview', () => {
  it('normalizes a raw timestamp string from the driver into a Date', async () => {
    // Exactly what node-postgres returns for the raw-sql subquery column.
    const rawRows = [
      {
        id: 'c1',
        psid: 'p1',
        aiState: 'bot',
        assignedTo: null,
        handoffReason: null,
        lastMessagePreview: 'مرحبا',
        lastMessageAt: '2026-06-23 08:20:26.338673+03',
      },
    ];

    const repo = makeRepo(rawRows, 1);
    const { items, total } = await repo.listConversationsWithPreview({});

    expect(total).toBe(1);
    expect(items[0].lastMessageAt).toBeInstanceOf(Date);
    // The +03 offset is normalized to UTC; .toISOString() must not throw.
    expect((items[0].lastMessageAt as Date).toISOString()).toBe(
      '2026-06-23T05:20:26.338Z',
    );
  });

  it('keeps a null timestamp as null (conversation with no messages)', async () => {
    const rawRows = [
      {
        id: 'c2',
        psid: 'p2',
        aiState: 'bot',
        assignedTo: null,
        handoffReason: null,
        lastMessagePreview: null,
        lastMessageAt: null,
      },
    ];

    const repo = makeRepo(rawRows, 1);
    const { items } = await repo.listConversationsWithPreview({});

    expect(items[0].lastMessageAt).toBeNull();
  });
});
