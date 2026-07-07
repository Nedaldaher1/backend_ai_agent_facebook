/**
 * Real-database integration harness for the RLS / tenant-isolation gates.
 *
 * Each suite gets a scratch database on the docker-compose Postgres
 * (docker compose up -d; pgvector image, owner role `masa`). The OWNER
 * connection creates/migrates/seeds; the APP connection uses the non-owner,
 * non-superuser `app_runtime` role — the exact role production uses — because
 * RLS is silently bypassed for owners/superusers and isolation tests that run
 * as the owner would go green while production leaks.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

/** Owner (migrations) connection base — matches docker-compose.yml. */
export const OWNER_BASE_URL =
  process.env.DATABASE_URL_MIGRATIONS ??
  process.env.TEST_OWNER_DATABASE_URL ??
  'postgres://masa:masa@localhost:5433/masa';

export const APP_ROLE = 'app_runtime';
export const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? 'app_runtime';

/** Two fixture tenants seeded side by side for isolation proofs. */
export const TENANT_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
export const TENANT_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

/** The 16 RLS-protected domain tables (tenant_isolation policy on each). */
export const DOMAIN_TABLES = [
  'admin_users',
  'agent_behavior',
  'product_categories',
  'products',
  'colors',
  'color_synonyms',
  'ad_product_links',
  'product_image_colors',
  'product_image_descriptions',
  'product_image_embeddings',
  'knowledge_entries',
  'conversations',
  'conversation_events',
  'messages',
  'orders',
  'order_items',
] as const;

const MIGRATIONS_DIR = resolve(__dirname, '../../drizzle');

export function scratchDbName(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function urlForDb(baseUrl: string, dbName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export function appUrlForDb(dbName: string): string {
  const u = new URL(urlForDb(OWNER_BASE_URL, dbName));
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

async function maintenanceClient(): Promise<Client> {
  const u = new URL(OWNER_BASE_URL);
  u.pathname = '/postgres';
  const client = new Client({ connectionString: u.toString() });
  await client.connect();
  return client;
}

export async function createScratchDb(dbName: string): Promise<void> {
  const client = await maintenanceClient();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

export async function dropScratchDb(dbName: string): Promise<void> {
  const client = await maintenanceClient();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await client.end();
  }
}

/** Apply ALL migrations (0000..latest) with drizzle's own migrator. */
export async function migrateAll(ownerUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl, max: 2 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}

interface JournalEntry {
  idx: number;
  tag: string;
}

export function readJournal(): JournalEntry[] {
  const raw = readFileSync(
    resolve(MIGRATIONS_DIR, 'meta/_journal.json'),
    'utf8',
  );
  const journal = JSON.parse(raw) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/** Execute one migration file statement-by-statement (breakpoint markers). */
export async function applyMigrationFile(
  client: Client,
  tag: string,
): Promise<void> {
  const sqlText = readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
  const statements = sqlText
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await client.query(statement);
  }
}

/** Apply migrations with idx <= maxIdx (e.g. 19 = the pre-tenancy schema). */
export async function applyMigrationsThrough(
  client: Client,
  maxIdx: number,
): Promise<void> {
  for (const entry of readJournal()) {
    if (entry.idx > maxIdx) break;
    await applyMigrationFile(client, entry.tag);
  }
}

/**
 * Local copy of db-init's ensureAppRole (that file is a CLI script whose
 * main() runs on import, so it cannot be imported here). Keep the grants in
 * sync with src/scripts/db-init.ts.
 */
export async function ensureAppRole(
  ownerClient: Client,
  dbName: string,
): Promise<void> {
  await ownerClient.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $$;`);
  await ownerClient.query(
    `ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
  );
  const grants = [
    `GRANT CONNECT ON DATABASE "${dbName}" TO ${APP_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
  ];
  for (const grant of grants) {
    await ownerClient.query(grant);
  }
}

/** A 1536-dim zero vector literal for product_image_embeddings fixtures. */
export function zeroVectorLiteral(): string {
  return `[${new Array(1536).fill(0).join(',')}]`;
}

export interface TenantFixture {
  tenantId: string;
  adminUserId: string;
  categoryId: string;
  productId: string;
  colorId: string;
  conversationId: string;
  orderId: string;
}

/**
 * Seed one row in EVERY domain table for the given tenant (as the OWNER, which
 * bypasses RLS — fixtures must exist regardless of policies). Returns the ids
 * needed by assertions.
 */
export async function seedTenantFixture(
  owner: Client,
  tenantId: string,
  label: string,
): Promise<TenantFixture> {
  const one = async (text: string, params: unknown[]): Promise<string> => {
    const res = await owner.query<{ id: string }>(text, params);
    return res.rows[0].id;
  };

  await owner.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, `Tenant ${label}`, `tenant-${label.toLowerCase()}`],
  );

  const adminUserId = await one(
    `INSERT INTO admin_users (tenant_id, email, password_hash, role)
     VALUES ($1, $2, 'x', 'admin') RETURNING id`,
    [tenantId, `admin@${label.toLowerCase()}.example`],
  );
  await owner.query(
    `INSERT INTO agent_behavior (tenant_id, persona, is_active)
     VALUES ($1, $2, true)`,
    [tenantId, `persona of ${label}`],
  );
  const categoryId = await one(
    `INSERT INTO product_categories (tenant_id, name, slug)
     VALUES ($1, $2, 'abaya') RETURNING id`,
    [tenantId, `عبايات ${label}`],
  );
  const colorId = await one(
    `INSERT INTO colors (tenant_id, name, family)
     VALUES ($1, $2, 'black') RETURNING id`,
    [tenantId, `أسود ${label}`],
  );
  await owner.query(
    `INSERT INTO color_synonyms (tenant_id, term, color_id)
     VALUES ($1, 'سادة', $2)`,
    [tenantId, colorId],
  );
  const productId = await one(
    `INSERT INTO products (tenant_id, created_by, category_id, name, price_jod, is_published, image_urls)
     VALUES ($1, $2, $3, $4, '25.000', true, ARRAY['k1.jpg']) RETURNING id`,
    [tenantId, adminUserId, categoryId, `Abaya ${label}`],
  );
  await owner.query(
    `INSERT INTO ad_product_links (tenant_id, ad_ref, product_id)
     VALUES ($1, $2, $3)`,
    [tenantId, `ad-${label.toLowerCase()}`, productId],
  );
  await owner.query(
    `INSERT INTO product_image_colors (tenant_id, product_id, storage_key, color_id)
     VALUES ($1, $2, 'k1.jpg', $3)`,
    [tenantId, productId, colorId],
  );
  await owner.query(
    `INSERT INTO product_image_descriptions (tenant_id, product_id, storage_key, description)
     VALUES ($1, $2, 'k1.jpg', $3)`,
    [tenantId, productId, `desc ${label}`],
  );
  await owner.query(
    `INSERT INTO product_image_embeddings (tenant_id, product_id, image_key, embedding, model_id)
     VALUES ($1, $2, 'k1.jpg', $3::vector, 'test-model')`,
    [tenantId, productId, zeroVectorLiteral()],
  );
  await owner.query(
    `INSERT INTO knowledge_entries (tenant_id, created_by, category, title, content, is_published)
     VALUES ($1, $2, 'shipping', $3, 'التوصيل خلال يومين', true)`,
    [tenantId, adminUserId, `شحن ${label}`],
  );
  const conversationId = await one(
    `INSERT INTO conversations (tenant_id, psid) VALUES ($1, $2) RETURNING id`,
    [tenantId, `psid-${label.toLowerCase()}`],
  );
  await owner.query(
    `INSERT INTO conversation_events (tenant_id, conversation_id, type, actor_type)
     VALUES ($1, $2, 'handoff', 'system')`,
    [tenantId, conversationId],
  );
  await owner.query(
    `INSERT INTO messages (tenant_id, conversation_id, role, content, external_id)
     VALUES ($1, $2, 'customer', $3, $4)`,
    [tenantId, conversationId, `مرحبا من ${label}`, `mid-${label}`],
  );
  const orderId = await one(
    `INSERT INTO orders (tenant_id, conversation_id, status, subtotal, delivery_fee, total)
     VALUES ($1, $2, 'draft', '25.000', '2.000', '27.000') RETURNING id`,
    [tenantId, conversationId],
  );
  await owner.query(
    `INSERT INTO order_items (tenant_id, order_id, product_id, storage_key, qty, unit_price, line_total)
     VALUES ($1, $2, $3, 'k1.jpg', 1, '25.000', '25.000')`,
    [tenantId, orderId, productId],
  );

  return {
    tenantId,
    adminUserId,
    categoryId,
    productId,
    colorId,
    conversationId,
    orderId,
  };
}
