import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { TenantContext } from './tenant-context';

/**
 * The ONE way domain repositories touch the database.
 *
 * Two granularities, one GUC contract (`app.tenant_id`, always bound with
 * `set_config(..., true)` = transaction-scoped, so it dies with COMMIT/ROLLBACK
 * and can never leak to the next request reusing the pooled connection):
 *
 *  - turn(fn): ONE transaction for a whole agent turn. The full Mastra
 *    generate loop — every tool call, every repository unit — shares a single
 *    transaction, GUC binding, and snapshot. The open transaction rides on
 *    AsyncLocalStorage; every tx() call inside the turn JOINS it as a
 *    SAVEPOINT instead of opening its own transaction.
 *  - tx(fn): outside a turn (admin HTTP, scripts), each unit of work is its
 *    own short transaction, exactly as before.
 *
 * Trade-offs of the turn transaction (accepted by design decision, 2026-07-07):
 * the turn holds one pooled connection for its full duration (LLM latency
 * included — tune Pool max accordingly), and writes become visible to other
 * connections only when the turn commits. Repository units keep their local
 * atomicity via savepoints: a failed unit rolls back to its savepoint and the
 * surrounding turn continues (escalation flows rely on this).
 *
 * detached(fn): escape hatch for fire-and-forget work spawned INSIDE a turn
 * (attribution, best-effort state merges). Unawaited work must NOT join the
 * turn transaction — its savepoint could race the turn's COMMIT — so it exits
 * the ambient scope and runs in its own short transaction(s).
 *
 * Fail-closed: if a query somehow runs OUTSIDE tx()/turn() on the app_runtime
 * role, no GUC is set, current_setting(..., true) is NULL, and RLS matches
 * zero rows.
 */
@Injectable()
export class TenantDb {
  /** The open turn transaction, ambient on ALS (undefined outside a turn). */
  private readonly turnStore = new AsyncLocalStorage<{ tx: Database }>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Run fn inside a tenant-bound transaction. Inside an open turn() this
   * becomes a SAVEPOINT on the turn transaction (same connection, same GUC,
   * unit-local rollback); otherwise it opens its own short transaction and
   * binds the ambient tenant. Drizzle nests inner db.transaction() calls as
   * savepoints, so multi-statement repository units keep their atomicity
   * unchanged in both modes.
   */
  tx<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const ambient = this.turnStore.getStore();
    if (ambient) {
      return ambient.tx.transaction((sp) => fn(sp as unknown as Database));
    }
    const tenantId = this.tenantContext.tenantId;
    return this.db.transaction(async (txClient) => {
      await txClient.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn(txClient);
    });
  }

  /**
   * Run fn — an entire agent turn — inside ONE transaction with the ambient
   * tenant bound once. Every tx() call in fn's async scope joins it as a
   * savepoint. Nested turn() calls join the existing turn. The transaction
   * commits when fn resolves and rolls back (all of the turn's writes) when
   * fn throws.
   */
  turn<T>(fn: () => Promise<T>): Promise<T> {
    if (this.turnStore.getStore()) {
      return fn();
    }
    const tenantId = this.tenantContext.tenantId;
    return this.db.transaction(async (txClient) => {
      await txClient.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return this.turnStore.run({ tx: txClient }, fn);
    });
  }

  /**
   * Run fn OUTSIDE any ambient turn transaction. Required for fire-and-forget
   * work spawned inside a turn: it commits independently in its own short
   * transaction(s) and cannot race the turn's COMMIT.
   */
  detached<T>(fn: () => Promise<T>): Promise<T> {
    return this.turnStore.exit(fn);
  }
}
