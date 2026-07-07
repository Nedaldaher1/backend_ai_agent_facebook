import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { TenantContext } from './tenant-context';

/**
 * The ONE way domain repositories touch the database.
 *
 * tx() opens a short transaction and binds the ambient tenant to it with
 * `set_config('app.tenant_id', $1, true)` — the parameterizable equivalent of
 * `SET LOCAL`: transaction-scoped, so the GUC dies with the COMMIT/ROLLBACK
 * and can never leak to the next request that reuses the pooled connection
 * (a session-level SET would). Every RLS policy reads exactly this GUC.
 *
 * Granularity is deliberately per-unit-of-work, NOT per-request: an agent turn
 * spans 10–40s of LLM calls, and holding one DB transaction (and its pooled
 * connection) across that would starve the pool. Repositories therefore wrap
 * each method (or multi-statement unit) in one tx() call; statements that must
 * be atomic together share a single tx() body.
 *
 * Fail-closed: if a query somehow runs OUTSIDE tx() on the app_runtime role,
 * no GUC is set, current_setting(..., true) is NULL, and RLS matches zero rows.
 */
@Injectable()
export class TenantDb {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Run fn inside a transaction with the ambient tenant bound. Drizzle nests
   * inner db.transaction() calls as savepoints, so existing multi-statement
   * repository units keep their atomicity unchanged.
   */
  tx<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const tenantId = this.tenantContext.tenantId;
    return this.db.transaction(async (txClient) => {
      await txClient.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      // A drizzle transaction exposes the same query API as the root client;
      // repositories are typed against Database, so narrow it back.
      return fn(txClient as unknown as Database);
    });
  }
}
