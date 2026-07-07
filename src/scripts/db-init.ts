/**
 * Dev database bootstrap — get a local Postgres ready for the app in one command.
 *
 *   pnpm db:init          create the database if it is missing, then apply all
 *                         Drizzle migrations (tables + the `vector` / `pg_trgm`
 *                         extensions the migrations declare).
 *   pnpm db:reset         DROP and recreate the database from scratch, then
 *                         re-apply every migration (a clean-slate dev reset).
 *
 * This is a DEVELOPER-ENVIRONMENT tool. It refuses to run when NODE_ENV is
 * 'production' — production schema changes go through the normal
 * `drizzle-kit migrate` deploy step, never through a script that can also drop
 * the database. In dev it is safe to run repeatedly: `db:init` is idempotent
 * (create-if-missing + migrate), and only `--reset` is destructive.
 *
 * Standalone: it does NOT boot Nest or the env schema, so it works before the
 * app can start and needs only DATABASE_URL (loaded from .env by the npm script
 * via node --env-file-if-exists). If DATABASE_URL is unset it falls back to the
 * documented local-dev default so a fresh clone works out of the box.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

const log = new Logger('db-init');

/** Matches .env.example / CLAUDE.md — the local WSL Postgres dev target. */
const DEV_DEFAULT_DATABASE_URL =
  'postgres://postgres:postgres@localhost:5432/masa';

/** Maintenance databases to try when we need a connection that is NOT the
 * target db (CREATE/DROP DATABASE cannot run while connected to that db). */
const MAINTENANCE_DBS = ['postgres', 'template1'];

interface Options {
  /** Drop and recreate the database before migrating (destructive, dev-only). */
  reset: boolean;
}

function parseArgs(argv: string[]): Options {
  return { reset: argv.includes('--reset') };
}

/** The database name encoded in a connection URL's path (`.../<dbname>`). */
function databaseNameFromUrl(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) {
    throw new Error('DATABASE_URL has no database name (expected .../<dbname>).');
  }
  return name;
}

/** Safely quote a SQL identifier (db name) for interpolation into DDL. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Hide the password when echoing a connection URL to the logs. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Open a client against a maintenance database on the same server as `url`
 * (not the target db itself), trying `postgres` then `template1`. Used for the
 * CREATE/DROP DATABASE statements, which must not run inside the target db.
 */
async function connectMaintenance(url: string): Promise<Client> {
  let lastErr: unknown;
  for (const maint of MAINTENANCE_DBS) {
    const u = new URL(url);
    u.pathname = `/${maint}`;
    const client = new Client({ connectionString: u.toString() });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
    }
  }
  throw lastErr;
}

/**
 * Ensure the target database exists. With `reset`, drop it first (terminating
 * other sessions so DROP DATABASE can proceed) and recreate it clean.
 */
async function ensureDatabase(
  url: string,
  dbName: string,
  reset: boolean,
): Promise<void> {
  const client = await connectMaintenance(url);
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    const exists = rowCount === 1;

    if (reset && exists) {
      log.warn(`--reset: dropping database "${dbName}"`);
      // Boot every other session off the db, otherwise DROP DATABASE errors.
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)}`);
    }

    if (reset || !exists) {
      log.log(`Creating database "${dbName}"`);
      await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    } else {
      log.log(`Database "${dbName}" already exists — applying migrations only`);
    }
  } finally {
    await client.end();
  }
}

/** Apply every migration in ./drizzle to the target database. */
async function runMigrations(url: string): Promise<void> {
  const migrationsFolder = resolve(process.cwd(), 'drizzle');
  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `Migrations folder not found at ${migrationsFolder}. ` +
        'Run this from the backend package root.',
    );
  }

  const pool = new Pool({ connectionString: url });
  try {
    log.log('Applying Drizzle migrations');
    await migrate(drizzle(pool), { migrationsFolder });
    log.log('Migrations applied');
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    log.error(
      'Refusing to run with NODE_ENV=production. This is a developer tool; ' +
        'apply production schema changes with `drizzle-kit migrate`.',
    );
    process.exit(1);
  }

  const { reset } = parseArgs(process.argv.slice(2));

  let url = process.env.DATABASE_URL;
  if (!url) {
    url = DEV_DEFAULT_DATABASE_URL;
    log.warn(
      `DATABASE_URL not set — using dev default ${maskUrl(url)}. ` +
        'Set it in .env to point elsewhere.',
    );
  }

  const dbName = databaseNameFromUrl(url);
  log.log(
    `Target: ${maskUrl(url)} (${reset ? 'reset + migrate' : 'ensure + migrate'})`,
  );

  await ensureDatabase(url, dbName, reset);
  await runMigrations(url);

  log.log(`Done — database "${dbName}" is ready.`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(msg);
  if (/ECONNREFUSED|could not connect|connection refused/i.test(msg)) {
    log.error(
      'Postgres is not reachable. Start it first (WSL: `sudo service postgresql start`).',
    );
  }
  if (/extension "vector"/i.test(msg)) {
    log.error(
      'The pgvector extension is required by the migrations. Install it ' +
        '(e.g. `sudo apt install postgresql-<version>-pgvector`) and re-run.',
    );
  }
  process.exit(1);
});
