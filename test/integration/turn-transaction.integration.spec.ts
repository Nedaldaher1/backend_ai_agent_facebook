/**
 * One-transaction-per-turn gates (design decision 2026-07-07): the entire
 * agent turn — every repository unit — must share ONE database transaction
 * and ONE tenant GUC binding via TenantDb.turn(), with:
 *
 *  (1) a single transaction: every tx() inside a turn reports the same
 *      txid_current(); independent tx() calls outside a turn do not.
 *  (2) savepoint semantics: a failing unit rolls back only itself; the turn
 *      survives and earlier writes commit with it.
 *  (3) turn atomicity: a throwing turn rolls back every write it made.
 *  (4) snapshot visibility: turn writes are invisible to other connections
 *      until the turn commits.
 *  (5) GUC hygiene: the binding dies with the turn (no leak to the pooled
 *      connection).
 *  (6) detached(): fire-and-forget work spawned inside a turn commits
 *      independently and never joins the turn transaction.
 *
 * Runs as app_runtime under RLS — the production role.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { TenantContext } from '@/core/tenancy/tenant-context';
import { TenantDb } from '@/core/tenancy/tenant-db';
import type { Database } from '@/core/database/drizzle';
import { products } from '@/modules/products/entities/product.entity';
import {
  TENANT_A,
  appUrlForDb,
  createScratchDb,
  dropScratchDb,
  ensureAppRole,
  migrateAll,
  scratchDbName,
  seedTenantFixture,
  urlForDb,
} from './harness';

async function currentTxId(db: Database): Promise<string> {
  const res = (await db.execute(
    sql`select txid_current()::text as txid`,
  )) as unknown as { rows: Array<{ txid: string }> };
  return res.rows[0].txid;
}

describe('TenantDb.turn(): one transaction per agent turn (real DB, app_runtime)', () => {
  const dbName = scratchDbName('masa_it_turn');
  let owner: Client;
  let appPool: Pool;
  let tenantDb: TenantDb;
  let tenantContext: TenantContext;

  beforeAll(async () => {
    await createScratchDb(dbName);
    const ownerUrl = urlForDb(
      process.env.DATABASE_URL_MIGRATIONS ??
        process.env.TEST_OWNER_DATABASE_URL ??
        'postgres://masa:masa@localhost:5433/masa',
      dbName,
    );
    await migrateAll(ownerUrl);
    owner = new Client({ connectionString: ownerUrl });
    await owner.connect();
    await ensureAppRole(owner, dbName);
    await seedTenantFixture(owner, TENANT_A, 'A');

    appPool = new Pool({ connectionString: appUrlForDb(dbName), max: 5 });
    tenantContext = new TenantContext({
      getOrThrow: () => TENANT_A,
    } as unknown as ConfigService);
    tenantDb = new TenantDb(drizzle(appPool), tenantContext);
  });

  afterAll(async () => {
    await appPool?.end();
    await owner?.end();
    await dropScratchDb(dbName);
  });

  const ownerCount = async (name: string): Promise<number> => {
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM products WHERE name = $1`,
      [name],
    );
    return Number(res.rows[0].n);
  };

  // ------------------------------------------------------------ gate (1)
  it('every tx() unit inside one turn shares ONE transaction', async () => {
    const txids = await tenantDb.turn(async () => {
      const first = await tenantDb.tx((db) => currentTxId(db));
      const second = await tenantDb.tx((db) => currentTxId(db));
      const third = await tenantDb.tx(async (db) => {
        // A read inside the same unit, then the txid — still the same tx.
        await db.select().from(products);
        return currentTxId(db);
      });
      return [first, second, third];
    });
    expect(new Set(txids).size).toBe(1);
  });

  it('tx() units outside a turn each get their own transaction', async () => {
    const first = await tenantDb.tx((db) => currentTxId(db));
    const second = await tenantDb.tx((db) => currentTxId(db));
    expect(first).not.toBe(second);
  });

  // ------------------------------------------------------------ gate (2)
  it('a failing unit rolls back to its savepoint; the turn survives and commits earlier writes', async () => {
    await tenantDb.turn(async () => {
      await tenantDb.tx((db) =>
        db.insert(products).values({ name: 'turn-keeper', priceJod: '10.000' }),
      );
      await expect(
        tenantDb.tx(async (db) => {
          await db
            .insert(products)
            .values({ name: 'turn-victim', priceJod: '11.000' });
          throw new Error('unit fails after writing');
        }),
      ).rejects.toThrow('unit fails after writing');
      // Turn still healthy: the keeper row is visible inside the turn.
      const rows = await tenantDb.tx((db) =>
        db.select().from(products).where(eq(products.name, 'turn-keeper')),
      );
      expect(rows).toHaveLength(1);
    });
    expect(await ownerCount('turn-keeper')).toBe(1);
    expect(await ownerCount('turn-victim')).toBe(0);
  });

  // ------------------------------------------------------------ gate (3)
  it('a throwing turn rolls back every write it made', async () => {
    await expect(
      tenantDb.turn(async () => {
        await tenantDb.tx((db) =>
          db
            .insert(products)
            .values({ name: 'turn-doomed', priceJod: '12.000' }),
        );
        throw new Error('turn fails');
      }),
    ).rejects.toThrow('turn fails');
    expect(await ownerCount('turn-doomed')).toBe(0);
  });

  // ------------------------------------------------------------ gate (4)
  it('turn writes are invisible to other connections until the turn commits', async () => {
    let midTurnCount = -1;
    await tenantDb.turn(async () => {
      await tenantDb.tx((db) =>
        db
          .insert(products)
          .values({ name: 'turn-snapshot', priceJod: '13.000' }),
      );
      midTurnCount = await ownerCount('turn-snapshot');
    });
    expect(midTurnCount).toBe(0);
    expect(await ownerCount('turn-snapshot')).toBe(1);
  });

  // ------------------------------------------------------------ gate (5)
  it('the turn GUC dies with the transaction (no leak on the pooled connection)', async () => {
    const singleConnPool = new Pool({
      connectionString: appUrlForDb(dbName),
      max: 1,
    });
    try {
      const singleDb = new TenantDb(drizzle(singleConnPool), tenantContext);
      const rows = await singleDb.turn(() =>
        singleDb.tx((db) => db.select().from(products)),
      );
      expect(rows.length).toBeGreaterThan(0);

      const afterTurn = await singleConnPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM products`,
      );
      expect(Number(afterTurn.rows[0].n)).toBe(0);
    } finally {
      await singleConnPool.end();
    }
  });

  // ------------------------------------------------------------ gate (6)
  it('detached() work commits independently, outside the turn transaction', async () => {
    let detachedVisibleMidTurn = -1;
    let turnRowVisibleMidTurn = -1;
    await tenantDb.turn(async () => {
      await tenantDb.tx((db) =>
        db
          .insert(products)
          .values({ name: 'turn-open-row', priceJod: '14.000' }),
      );
      await tenantDb.detached(() =>
        tenantDb.tx((db) =>
          db
            .insert(products)
            .values({ name: 'detached-row', priceJod: '15.000' }),
        ),
      );
      // The detached write is already committed while the turn is still open;
      // the turn's own write is not.
      detachedVisibleMidTurn = await ownerCount('detached-row');
      turnRowVisibleMidTurn = await ownerCount('turn-open-row');
    });
    expect(detachedVisibleMidTurn).toBe(1);
    expect(turnRowVisibleMidTurn).toBe(0);
    expect(await ownerCount('turn-open-row')).toBe(1);
  });

  it('nested turn() joins the outer turn instead of opening a second transaction', async () => {
    const [outer, inner] = await tenantDb.turn(async () => {
      const outerTx = await tenantDb.tx((db) => currentTxId(db));
      const innerTx = await tenantDb.turn(() =>
        tenantDb.tx((db) => currentTxId(db)),
      );
      return [outerTx, innerTx];
    });
    expect(outer).toBe(inner);
  });
});
