/**
 * Phase 1 acceptance gate (5): the '__unassigned__' sentinel color must be
 * resolved PER TENANT — both in the database (each tenant seeds its own row)
 * and in ColorsService's in-process cache (a Map keyed by tenant id). A single
 * process-wide cached id would hand tenant B a foreign-tenant color id, and
 * the safe-delete flow would re-tag B's images onto A's sentinel.
 *
 * Exercises the REAL stack: ColorsService → ColorsRepository → TenantDb →
 * app_runtime connection under RLS.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import type { ConfigService } from '@nestjs/config';
import { TenantContext } from '@/core/tenancy/tenant-context';
import { TenantDb } from '@/core/tenancy/tenant-db';
import type { Database } from '@/core/database/drizzle';
import { ColorsService } from '@/modules/products/colors.service';
import { ColorsRepository } from '@/modules/products/colors.repository';
import { ProductImageColorsRepository } from '@/modules/products/product-image-colors.repository';
import {
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

describe('sentinel color cache is tenant-keyed (real DB, app_runtime)', () => {
  const dbName = scratchDbName('masa_it_sentinel');
  let owner: Client;
  let appPool: Pool;
  let tenantContext: TenantContext;
  let service: ColorsService;
  let sentinelA: string;
  let sentinelB: string;

  const cacheOf = (svc: ColorsService): Map<string, string> =>
    (svc as unknown as { sentinelIdByTenant: Map<string, string> })
      .sentinelIdByTenant;

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

    // Each tenant gets its OWN sentinel row — what tenant provisioning will do.
    const insertSentinel = async (tenantId: string): Promise<string> => {
      const res = await owner.query<{ id: string }>(
        `INSERT INTO colors (tenant_id, name, family, is_system, is_active)
         VALUES ($1, 'غير معرف', '__unassigned__', true, false) RETURNING id`,
        [tenantId],
      );
      return res.rows[0].id;
    };
    sentinelA = await insertSentinel(TENANT_A);
    sentinelB = await insertSentinel(TENANT_B);
    expect(sentinelA).not.toBe(sentinelB);

    appPool = new Pool({ connectionString: appUrlForDb(dbName), max: 5 });
    tenantContext = new TenantContext({
      getOrThrow: () => TENANT_A,
    } as unknown as ConfigService);
    const tenantDb = new TenantDb(drizzle(appPool), tenantContext);
    service = new ColorsService(
      new ColorsRepository(tenantDb),
      new ProductImageColorsRepository(tenantDb),
      tenantContext,
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await owner?.end();
    await dropScratchDb(dbName);
  });

  it("resolves each tenant's own sentinel and never serves the other's from cache", async () => {
    // Tenant A resolves first and warms the cache.
    await tenantContext.runWith(TENANT_A, () => service.unassignedUsage());
    expect(cacheOf(service).get(TENANT_A)).toBe(sentinelA);

    // Tenant B resolves AFTER A warmed the cache — the exact scenario where a
    // process-wide cached id would leak A's sentinel into B's flows.
    await tenantContext.runWith(TENANT_B, () => service.unassignedUsage());
    expect(cacheOf(service).get(TENANT_B)).toBe(sentinelB);

    expect(cacheOf(service).get(TENANT_A)).not.toBe(
      cacheOf(service).get(TENANT_B),
    );
  });

  it('cache hits stay tenant-correct on repeat resolution', async () => {
    await tenantContext.runWith(TENANT_A, () => service.unassignedUsage());
    await tenantContext.runWith(TENANT_B, () => service.unassignedUsage());
    expect(cacheOf(service).get(TENANT_A)).toBe(sentinelA);
    expect(cacheOf(service).get(TENANT_B)).toBe(sentinelB);
    expect(cacheOf(service).size).toBe(2);
  });
});
