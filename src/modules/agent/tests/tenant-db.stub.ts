import type { TenantDb } from '@/core/tenancy/tenant-db';

/**
 * Pass-through TenantDb for unit specs: no DB, no transactions — turn() and
 * detached() just run their callbacks, so handleMessage flows behave exactly
 * as before the one-transaction-per-turn wrapper. Real transaction semantics
 * are covered by test/integration/turn-transaction.integration.spec.ts.
 */
export function stubTenantDb(): TenantDb {
  return {
    turn: <T>(fn: () => Promise<T>) => fn(),
    detached: <T>(fn: () => Promise<T>) => fn(),
    tx: () => {
      throw new Error(
        'unit specs must not reach TenantDb.tx directly — mock the repository',
      );
    },
  } as unknown as TenantDb;
}
