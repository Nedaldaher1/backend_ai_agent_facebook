/**
 * Phase 1 RLS acceptance gates (real DB, connected as app_runtime):
 *
 *  (1) withTenant/SET LOCAL — interleaved tenant-A/tenant-B work on ONE pool
 *      never crosses, and the GUC dies with each transaction (no leak to the
 *      next request reusing the pooled connection).
 *  (2) Fail-closed — with NO GUC bound, every RLS-protected table returns
 *      ZERO rows (not an error, not a leak). Runs under app_runtime.
 *  (3) WITH CHECK — INSERT/UPDATE carrying a foreign tenant_id are rejected
 *      by the DB while scoped to tenant A.
 *  (4) Harness realism — app_runtime is NOT a superuser and owns NO domain
 *      table; the suite fails if isolation would be tested as the owner.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { TenantContext } from '@/core/tenancy/tenant-context';
import { TenantDb } from '@/core/tenancy/tenant-db';
import type { Database } from '@/core/database/drizzle';
import { products } from '@/modules/products/entities/product.entity';
import { conversations } from '@/modules/conversations/entities/conversation.entity';
import { orders } from '@/modules/orders/entities/order.entity';
import { knowledgeEntries } from '@/modules/knowledge/entities/knowledge-entry.entity';
import { colors } from '@/modules/products/entities/color.entity';
import {
  APP_ROLE,
  DOMAIN_TABLES,
  TENANT_A,
  TENANT_B,
  appUrlForDb,
  createScratchDb,
  dropScratchDb,
  ensureAppRole,
  migrateAll,
  scratchDbName,
  seedTenantFixture,
  urlForDb,
} from './harness';

const RLS_VIOLATION = '42501';
const NOT_NULL_VIOLATION = '23502';

/** Postgres error code, unwrapping drizzle's DrizzleQueryError -> cause chain. */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const candidate = (current as { code?: unknown }).code;
    if (typeof candidate === 'string') return candidate;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectPgError(
  work: Promise<unknown>,
  ...codes: string[]
): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  expect(codes).toContain(pgErrorCode(thrown));
}

function buildTenantContext(): TenantContext {
  // Default irrelevant here — every test binds explicitly via runWith.
  const config = {
    getOrThrow: () => TENANT_A,
  } as unknown as ConfigService;
  return new TenantContext(config);
}

describe('RLS tenant isolation (app_runtime, real DB)', () => {
  const dbName = scratchDbName('masa_it_rls');
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
    await seedTenantFixture(owner, TENANT_B, 'B');

    appPool = new Pool({ connectionString: appUrlForDb(dbName), max: 10 });
    tenantContext = buildTenantContext();
    tenantDb = new TenantDb(drizzle(appPool), tenantContext);
  });

  afterAll(async () => {
    await appPool?.end();
    await owner?.end();
    await dropScratchDb(dbName);
  });

  // ------------------------------------------------------------ criterion (4)
  describe('harness connects as the production app role, not the owner', () => {
    it('app_runtime is not a superuser and does not bypass RLS', async () => {
      const res = await appPool.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT current_user,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls`,
      );
      expect(res.rows[0].current_user).toBe(APP_ROLE);
      expect(res.rows[0].rolsuper).toBe(false);
      expect(res.rows[0].rolbypassrls).toBe(false);
    });

    it('app_runtime owns zero public tables (owners bypass RLS)', async () => {
      const res = await appPool.query<{ owned: string }>(
        `SELECT count(*)::text AS owned FROM pg_tables
         WHERE schemaname = 'public' AND tableowner = current_user`,
      );
      expect(Number(res.rows[0].owned)).toBe(0);
    });

    it('every domain table has RLS enabled and the tenant_isolation policy with USING + WITH CHECK', async () => {
      const rls = await appPool.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity
         ORDER BY c.relname`,
      );
      expect(rls.rows.map((r) => r.relname).sort()).toEqual(
        [...DOMAIN_TABLES].sort(),
      );
      const policies = await appPool.query<{
        tablename: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename, qual, with_check FROM pg_policies
         WHERE policyname = 'tenant_isolation'`,
      );
      expect(policies.rows).toHaveLength(DOMAIN_TABLES.length);
      for (const row of policies.rows) {
        expect(row.qual).toContain('app.tenant_id');
        expect(row.with_check).toContain('app.tenant_id');
      }
    });
  });

  // ------------------------------------------------------------ criterion (2)
  describe('fail-closed: no GUC bound → zero rows, no error', () => {
    it.each([...DOMAIN_TABLES])(
      '%s: app sees 0 rows without a tenant GUC while the owner sees the fixtures',
      async (table) => {
        const ownerCount = await owner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"`,
        );
        expect(Number(ownerCount.rows[0].n)).toBeGreaterThan(0);

        const appCount = await appPool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"`,
        );
        expect(Number(appCount.rows[0].n)).toBe(0);
      },
    );
  });

  // ------------------------------------------------------------ criterion (1)
  describe('withTenant transactions: interleaved tenants on one pool', () => {
    it('20 interleaved rounds of tenant A and tenant B never cross', async () => {
      for (let round = 0; round < 20; round++) {
        const [aRows, bRows] = await Promise.all([
          tenantContext.runWith(TENANT_A, () =>
            tenantDb.tx((db) => db.select().from(products)),
          ),
          tenantContext.runWith(TENANT_B, () =>
            tenantDb.tx((db) => db.select().from(products)),
          ),
        ]);
        expect(aRows).toHaveLength(1);
        expect(bRows).toHaveLength(1);
        expect(aRows.every((r) => r.tenantId === TENANT_A)).toBe(true);
        expect(bRows.every((r) => r.tenantId === TENANT_B)).toBe(true);
      }
    });

    it('the GUC is transaction-local: the SAME connection sees zero rows right after a tenant tx', async () => {
      // max:1 pool guarantees the follow-up query reuses the exact connection
      // the tenant transaction ran on — a session-level SET would leak here.
      const singleConnPool = new Pool({
        connectionString: appUrlForDb(dbName),
        max: 1,
      });
      try {
        const singleDb = new TenantDb(drizzle(singleConnPool), tenantContext);
        const aRows = await tenantContext.runWith(TENANT_A, () =>
          singleDb.tx((db) => db.select().from(products)),
        );
        expect(aRows).toHaveLength(1);

        const afterTx = await singleConnPool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM products`,
        );
        expect(Number(afterTx.rows[0].n)).toBe(0);

        const guc = await singleConnPool.query<{ v: string | null }>(
          `SELECT current_setting('app.tenant_id', true) AS v`,
        );
        expect([null, ''].includes(guc.rows[0].v)).toBe(true);

        const bRows = await tenantContext.runWith(TENANT_B, () =>
          singleDb.tx((db) => db.select().from(products)),
        );
        expect(bRows).toHaveLength(1);
        expect(bRows[0].tenantId).toBe(TENANT_B);
      } finally {
        await singleConnPool.end();
      }
    });

    it('reads across representative tables are scoped to the bound tenant', async () => {
      await tenantContext.runWith(TENANT_A, () =>
        tenantDb.tx(async (db) => {
          // Sequential on purpose: one tx = one connection; concurrent queries
          // on a single pg client only get queued (deprecation warning).
          const convs = await db.select().from(conversations);
          const ords = await db.select().from(orders);
          const knows = await db.select().from(knowledgeEntries);
          const cols = await db.select().from(colors);
          for (const rows of [convs, ords, knows, cols]) {
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
          }
        }),
      );
    });
  });

  // ------------------------------------------------------------ criterion (3)
  describe('WITH CHECK: writes carrying a foreign tenant_id are rejected', () => {
    it('INSERT with tenant B while scoped to tenant A → DB error 42501', async () => {
      await expectPgError(
        tenantContext.runWith(TENANT_A, () =>
          tenantDb.tx((db) =>
            db.insert(products).values({
              tenantId: TENANT_B,
              name: 'smuggled product',
              priceJod: '9.000',
            }),
          ),
        ),
        RLS_VIOLATION,
      );
    });

    it('UPDATE moving a row to tenant B while scoped to tenant A → DB error 42501', async () => {
      await expectPgError(
        tenantContext.runWith(TENANT_A, () =>
          tenantDb.tx((db) =>
            db
              .update(products)
              .set({ tenantId: TENANT_B })
              .where(eq(products.tenantId, TENANT_A)),
          ),
        ),
        RLS_VIOLATION,
      );
    });

    it('positive control: INSERT without tenant_id lands on the bound tenant via the GUC default', async () => {
      const inserted = await tenantContext.runWith(TENANT_A, () =>
        tenantDb.tx((db) =>
          db
            .insert(products)
            .values({ name: 'default-tenant product', priceJod: '10.000' })
            .returning(),
        ),
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0].tenantId).toBe(TENANT_A);

      // And tenant B cannot see it.
      const bView = await tenantContext.runWith(TENANT_B, () =>
        tenantDb.tx((db) =>
          db.select().from(products).where(eq(products.id, inserted[0].id)),
        ),
      );
      expect(bView).toHaveLength(0);
    });

    it('write with NO tenant bound fails loudly (NULL default + NOT NULL)', async () => {
      // Raw client, no GUC: the tenant_id default evaluates to NULL and the
      // NOT NULL constraint rejects — fail-closed writes, never mis-filed rows.
      await expectPgError(
        appPool.query(
          `INSERT INTO products (name, price_jod) VALUES ('orphan', '5.000')`,
        ),
        NOT_NULL_VIOLATION,
        RLS_VIOLATION,
      );
    });
  });
});
