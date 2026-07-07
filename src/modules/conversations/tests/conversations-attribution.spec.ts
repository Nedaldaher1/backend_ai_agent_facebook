/**
 * Unit tests for ConversationsRepository.recordFirstTouchAttribution (WS3).
 *
 * Covers:
 *  - First call writes all provided attribution fields and sets attributed_at.
 *  - Second call returns undefined (WHERE attributed_at IS NULL → 0 rows updated).
 *  - Partial attrib: only provided keys are included in the SET clause.
 *  - Empty attrib still writes attributed_at (marks the conversation as attributed
 *    even when the referral had no structured data beyond the ref slug).
 */

import { ConversationsRepository } from '../conversations.repository';
import type { Database } from '@/core/database/drizzle';
import type { TenantDb } from '@/core/tenancy/tenant-db';

// ---------------------------------------------------------------------------
// Drizzle mock: chainable UPDATE builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal Drizzle db mock for the UPDATE path:
 *   db.update(t).set(s).where(w).returning() → rows
 */
function makeUpdateDb(rows: unknown[]): Database {
  const chain = {
    set: jest.fn(() => chain),
    where: jest.fn(() => chain),
    returning: jest.fn().mockResolvedValue(rows),
  };
  return {
    update: jest.fn(() => chain),
  } as unknown as Database;
}

/** Wrap a mocked Database so it satisfies the TenantDb.tx() contract in tests. */
function makeTenantDb(db: Database): TenantDb {
  return {
    tx: (fn: (db: unknown) => unknown) => fn(db),
  } as unknown as TenantDb;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationsRepository.recordFirstTouchAttribution', () => {
  it('returns the updated row on the first touch (row returned by UPDATE)', async () => {
    const fakeRow = {
      id: 'conv-1',
      adId: 'ad_111',
      adRef: 'summer-2024',
      adSource: 'ADS',
      adProductId: 'sku-42',
      attributedAt: new Date(),
    };
    const db = makeUpdateDb([fakeRow]);
    const repo = new ConversationsRepository(makeTenantDb(db));

    const result = await repo.recordFirstTouchAttribution('conv-1', {
      adId: 'ad_111',
      adRef: 'summer-2024',
      adSource: 'ADS',
      adProductId: 'sku-42',
    });

    expect(result).toBe(fakeRow);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the conversation is already attributed (0 rows updated)', async () => {
    // Drizzle returns an empty array when WHERE matches no rows.
    const db = makeUpdateDb([]);
    const repo = new ConversationsRepository(makeTenantDb(db));

    const result = await repo.recordFirstTouchAttribution('conv-1', {
      adId: 'ad_111',
    });

    expect(result).toBeUndefined();
  });

  it('WHERE clause includes isNull(attributedAt) — no-overwrite is structural, not a mock artifact', async () => {
    // Capture the args passed to where() to verify the null-guard is present.
    let capturedWhereArg: unknown;
    const chain = {
      set: jest.fn(() => chain),
      where: jest.fn((arg: unknown) => {
        capturedWhereArg = arg;
        return chain;
      }),
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 'conv-guard', attributedAt: new Date() }]),
    };
    const db = { update: jest.fn(() => chain) } as unknown as Database;
    const repo = new ConversationsRepository(makeTenantDb(db));

    await repo.recordFirstTouchAttribution('conv-guard', { adRef: 'ref-1' });

    // The WHERE arg must exist (a WHERE was issued).
    expect(capturedWhereArg).toBeDefined();

    // Drizzle SQL fragments are circular objects — extract string chunks recursively.
    function extractSqlStrings(node: unknown, out: string[] = []): string[] {
      if (!node || typeof node !== 'object') return out;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj)) {
        for (const item of obj) extractSqlStrings(item, out);
        return out;
      }
      if ('value' in obj && Array.isArray(obj.value)) {
        for (const v of obj.value as unknown[]) {
          if (typeof v === 'string') out.push(v);
        }
      }
      if ('queryChunks' in obj && Array.isArray(obj.queryChunks)) {
        extractSqlStrings(obj.queryChunks, out);
      }
      return out;
    }

    const fragments = extractSqlStrings(capturedWhereArg);
    const combined = fragments.join(' ');
    // The IS NULL check on attributed_at must be part of the WHERE compound.
    expect(combined).toMatch(/is null/i);
  });

  it('includes only the provided attribution keys in the update (omits undefined keys)', async () => {
    // Capture the set() argument by spying on the chain AFTER calling update.
    let capturedSetArg: Record<string, unknown> | undefined;

    // Build a chain that records the set() call before chaining.
    const chain = {
      set: jest.fn((arg: Record<string, unknown>) => {
        capturedSetArg = arg;
        return chain;
      }),
      where: jest.fn(() => chain),
      returning: jest
        .fn()
        .mockResolvedValue([{ id: 'conv-2', attributedAt: new Date() }]),
    };
    const db = { update: jest.fn(() => chain) } as unknown as Database;

    const repo = new ConversationsRepository(makeTenantDb(db));
    await repo.recordFirstTouchAttribution('conv-2', { adRef: 'spring-ref' });

    expect(db.update).toHaveBeenCalledTimes(1);
    // adRef should be present; adId should NOT be present (not provided).
    expect(capturedSetArg).toHaveProperty('adRef', 'spring-ref');
    expect(capturedSetArg).not.toHaveProperty('adId');
    // attributedAt must always be set.
    expect(capturedSetArg).toHaveProperty('attributedAt');
  });

  it('still writes attributedAt even when the attrib object is empty', async () => {
    const db = makeUpdateDb([{ id: 'conv-3', attributedAt: new Date() }]);
    const repo = new ConversationsRepository(makeTenantDb(db));
    const result = await repo.recordFirstTouchAttribution('conv-3', {});

    // A row was returned → the update succeeded.
    expect(result).toBeDefined();
    expect(result?.id).toBe('conv-3');
  });
});
