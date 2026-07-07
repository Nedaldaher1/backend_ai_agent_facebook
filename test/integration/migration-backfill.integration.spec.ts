/**
 * Migration 0020 backfill-integrity gate: build the PRE-tenancy schema
 * (migrations 0000–0019), seed representative single-tenant Masa data —
 * including an order whose conversation link is NULL (the case where tenant_id
 * cannot be derived from a parent) — then apply 0020 and prove:
 *   - every legacy row got the pinned Masa tenant_id, counts preserved
 *   - the global uniques became tenant-composite (second tenant's sentinel
 *     color / 'abaya' slug now insertable)
 *   - policies + RLS flags + partial uniques + GUC default exist
 */
import { Client } from 'pg';
import { MASA_TENANT_ID } from '@/modules/tenants/tenants.constants';
import {
  DOMAIN_TABLES,
  applyMigrationFile,
  applyMigrationsThrough,
  createScratchDb,
  dropScratchDb,
  readJournal,
  scratchDbName,
  urlForDb,
  zeroVectorLiteral,
} from './harness';

const PRE_TENANCY_MAX_IDX = 19;

describe('migration 0020: Masa backfill integrity (real DB)', () => {
  const dbName = scratchDbName('masa_it_mig');
  let owner: Client;
  const preCounts = new Map<string, number>();

  const count = async (table: string): Promise<number> => {
    const res = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"`,
    );
    return Number(res.rows[0].n);
  };

  beforeAll(async () => {
    await createScratchDb(dbName);
    owner = new Client({
      connectionString: urlForDb(
        process.env.DATABASE_URL_MIGRATIONS ??
          process.env.TEST_OWNER_DATABASE_URL ??
          'postgres://masa:masa@localhost:5433/masa',
        dbName,
      ),
    });
    await owner.connect();
    await applyMigrationsThrough(owner, PRE_TENANCY_MAX_IDX);

    // ---- Seed the single-tenant era (NO tenant_id columns exist yet) ----
    const admin = await owner.query<{ id: string }>(
      `INSERT INTO admin_users (email, password_hash, role)
       VALUES ('admin@masa.example', 'x', 'admin') RETURNING id`,
    );
    const adminId = admin.rows[0].id;
    await owner.query(
      `INSERT INTO agent_behavior (persona, is_active) VALUES ('لمى', true)`,
    );
    // The 'abaya' category was seeded by migration 0017 with a fixed uuid.
    const category = await owner.query<{ id: string }>(
      `SELECT id FROM product_categories WHERE slug = 'abaya'`,
    );
    const categoryId = category.rows[0].id;
    // The '__unassigned__' sentinel color was seeded by migration 0006.
    const sentinel = await owner.query<{ id: string }>(
      `SELECT id FROM colors WHERE family = '__unassigned__'`,
    );
    expect(sentinel.rows).toHaveLength(1);
    const color = await owner.query<{ id: string }>(
      `INSERT INTO colors (name, family) VALUES ('نبيتي', 'red') RETURNING id`,
    );
    const colorId = color.rows[0].id;
    await owner.query(
      `INSERT INTO color_synonyms (term, color_id) VALUES ('خمري', $1)`,
      [colorId],
    );
    const product = await owner.query<{ id: string }>(
      `INSERT INTO products (created_by, category_id, name, price_jod, is_published, image_urls, sku)
       VALUES ($1, $2, 'عباية مطرزة', '35.000', true, ARRAY['img1.jpg'], 'AB-001') RETURNING id`,
      [adminId, categoryId],
    );
    const productId = product.rows[0].id;
    await owner.query(
      `INSERT INTO ad_product_links (ad_ref, product_id) VALUES ('ramadan-1', $1)`,
      [productId],
    );
    await owner.query(
      `INSERT INTO product_image_colors (product_id, storage_key, color_id)
       VALUES ($1, 'img1.jpg', $2)`,
      [productId, colorId],
    );
    await owner.query(
      `INSERT INTO product_image_descriptions (product_id, storage_key, description)
       VALUES ($1, 'img1.jpg', 'عباية سوداء مطرزة')`,
      [productId],
    );
    await owner.query(
      `INSERT INTO product_image_embeddings (product_id, image_key, embedding, model_id)
       VALUES ($1, 'img1.jpg', $2::vector, 'gemini-embedding-2')`,
      [productId, zeroVectorLiteral()],
    );
    await owner.query(
      `INSERT INTO knowledge_entries (created_by, category, title, content, is_published)
       VALUES ($1, 'shipping', 'التوصيل', 'يومين عمل', true)`,
      [adminId],
    );
    const conv = await owner.query<{ id: string }>(
      `INSERT INTO conversations (psid) VALUES ('psid-legacy-1') RETURNING id`,
    );
    const convId = conv.rows[0].id;
    await owner.query(
      `INSERT INTO conversation_events (conversation_id, type, actor_type)
       VALUES ($1, 'handoff', 'agent')`,
      [convId],
    );
    await owner.query(
      `INSERT INTO messages (conversation_id, role, content, external_id)
       VALUES ($1, 'customer', 'بدي عباية', 'mid-legacy-1')`,
      [convId],
    );
    const orderWithConv = await owner.query<{ id: string }>(
      `INSERT INTO orders (conversation_id, status, subtotal, delivery_fee, total)
       VALUES ($1, 'draft', '35.000', '2.000', '37.000') RETURNING id`,
      [convId],
    );
    await owner.query(
      `INSERT INTO order_items (order_id, product_id, storage_key, qty, unit_price, line_total)
       VALUES ($1, $2, 'img1.jpg', 1, '35.000', '35.000')`,
      [orderWithConv.rows[0].id, productId],
    );
    // The tenant-underivable case: an order whose conversation was deleted.
    await owner.query(
      `INSERT INTO orders (conversation_id, status, subtotal, delivery_fee, total)
       VALUES (NULL, 'confirmed', '20.000', '2.000', '22.000')`,
    );

    for (const table of DOMAIN_TABLES) {
      preCounts.set(table, await count(table));
    }

    // ---- Apply the tenancy migration under test ----
    const entry0020 = readJournal().find((e) => e.idx === 20);
    if (!entry0020) throw new Error('journal has no idx-20 entry');
    await applyMigrationFile(owner, entry0020.tag);
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDb(dbName);
  });

  it('seeds the pinned Masa tenant and the dev plan', async () => {
    const tenant = await owner.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM tenants`,
    );
    expect(tenant.rows).toEqual([
      expect.objectContaining({ id: MASA_TENANT_ID, slug: 'masa' }),
    ]);
    const plan = await owner.query<{ name: string }>(`SELECT name FROM plans`);
    expect(plan.rows).toEqual([
      expect.objectContaining({ name: 'dev-unlimited' }),
    ]);
  });

  it.each([...DOMAIN_TABLES])(
    '%s: every legacy row got the Masa tenant_id and counts are preserved',
    async (table) => {
      const expected = preCounts.get(table);
      expect(expected).toBeGreaterThan(0);
      const total = await count(table);
      expect(total).toBe(expected);
      const masa = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE tenant_id = $1`,
        [MASA_TENANT_ID],
      );
      expect(Number(masa.rows[0].n)).toBe(expected);
      const nulls = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE tenant_id IS NULL`,
      );
      expect(Number(nulls.rows[0].n)).toBe(0);
    },
  );

  it('the NULL-conversation order was backfilled by constant, not parent derivation', async () => {
    const res = await owner.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM orders WHERE conversation_id IS NULL`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].tenant_id).toBe(MASA_TENANT_ID);
  });

  it('swaps the global uniques for tenant-composite ones', async () => {
    const indexes = await owner.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(indexes.rows.map((r) => r.indexname));
    // New composite/partial indexes present:
    for (const idx of [
      'colors_tenant_family_idx',
      'color_synonyms_tenant_term_idx',
      'product_categories_tenant_slug_idx',
      'products_tenant_sku_idx',
      'products_tenant_published_idx',
      'conversations_tenant_psid_idx',
      'agent_behavior_tenant_active_idx',
      'orders_conversation_draft_uq',
      'ad_product_links_tenant_ad_ref_active_idx',
      'knowledge_entries_tenant_published_idx',
      'messages_tenant_created_idx',
      'orders_tenant_status_idx',
    ]) {
      expect(names).toContain(idx);
    }
    // Old single-tenant uniques/indexes gone:
    for (const idx of [
      'colors_family_idx',
      'color_synonyms_term_idx',
      'product_categories_slug_idx',
      'products_sku_idx',
      'products_is_published_idx',
      'conversations_psid_idx',
      'knowledge_entries_is_published_idx',
      'ad_product_links_ad_ref_active_idx',
    ]) {
      expect(names).not.toContain(idx);
    }
    // The tenant-safe dedup key deliberately survives unchanged:
    expect(names).toContain('messages_conversation_external_id_uq');
  });

  it('enables RLS + tenant_isolation (USING and WITH CHECK) on all 16 domain tables', async () => {
    const rls = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity ORDER BY c.relname`,
    );
    expect(rls.rows.map((r) => r.relname).sort()).toEqual(
      [...DOMAIN_TABLES].sort(),
    );
    const policies = await owner.query<{
      qual: string | null;
      with_check: string | null;
    }>(`SELECT qual, with_check FROM pg_policies WHERE policyname = 'tenant_isolation'`);
    expect(policies.rows).toHaveLength(DOMAIN_TABLES.length);
    for (const p of policies.rows) {
      expect(p.qual).toContain('app.tenant_id');
      expect(p.with_check).toContain('app.tenant_id');
    }
  });

  it('installs the GUC default on tenant_id (fail-closed inserts)', async () => {
    const res = await owner.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'tenant_id'`,
    );
    expect(res.rows[0].column_default).toContain('app.tenant_id');
  });

  it('a second tenant can now seed its own sentinel color and abaya category', async () => {
    const t2 = 'cccccccc-0000-4000-8000-0000000000cc';
    await owner.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Second Brand', 'second')`,
      [t2],
    );
    // Pre-0020 these violated the GLOBAL uniques (family / slug). Now they are
    // per-tenant and must succeed:
    await owner.query(
      `INSERT INTO colors (tenant_id, name, family, is_system, is_active)
       VALUES ($1, 'غير معرف', '__unassigned__', true, false)`,
      [t2],
    );
    await owner.query(
      `INSERT INTO product_categories (tenant_id, name, slug) VALUES ($1, 'عبايات', 'abaya')`,
      [t2],
    );
    // And the per-tenant single-active-persona invariant holds for the NEW
    // tenant independently of Masa's active row:
    await owner.query(
      `INSERT INTO agent_behavior (tenant_id, persona, is_active) VALUES ($1, 'p2', true)`,
      [t2],
    );
    await expect(
      owner.query(
        `INSERT INTO agent_behavior (tenant_id, persona, is_active) VALUES ($1, 'p3', true)`,
        [t2],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('conversations gained a nullable channel_id (backfilled later by the bootstrap script)', async () => {
    const res = await owner.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'channel_id'`,
    );
    expect(res.rows[0]?.is_nullable).toBe('YES');
  });
});
