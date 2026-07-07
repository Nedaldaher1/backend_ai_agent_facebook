/**
 * Dev-mode channel bootstrap — connect the Masa Facebook page as a `channels`
 * row, the way the super-admin API will do for every tenant from Phase 6 on.
 *
 *   pnpm tenant:bootstrap-masa
 *
 * Reads MESSENGER_PAGE_ID + MESSENGER_PAGE_ACCESS_TOKEN + CHANNEL_TOKEN_ENC_KEY
 * from the environment, encrypts the token (AES-256-GCM), UPSERTs the channel
 * for the Masa tenant (by page_id), and backfills conversations.channel_id for
 * Masa rows that predate channels. Idempotent: re-running refreshes the stored
 * token. Deliberately NOT a SQL migration — the page id and token are
 * env-specific secret material that must never live in static migration files.
 *
 * Skips gracefully (exit 0 with a warning) when the Messenger env vars are
 * unset, so environments without Meta credentials (CI, fresh clones) can run
 * the full setup chain without failing.
 */
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { encryptToken } from '@/core/security/token-crypto';
import { MASA_TENANT_ID } from '@/modules/tenants/tenants.constants';

const log = new Logger('bootstrap-masa-channel');

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL ?? '';
  if (!url) {
    log.error('DATABASE_URL (or DATABASE_URL_MIGRATIONS) is required.');
    process.exit(1);
  }

  const pageId = process.env.MESSENGER_PAGE_ID;
  const pageToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  if (!pageId || !pageToken) {
    log.warn(
      'MESSENGER_PAGE_ID / MESSENGER_PAGE_ACCESS_TOKEN not set — nothing to ' +
        'bootstrap (fine for environments without Meta credentials).',
    );
    return;
  }

  const encKey = process.env.CHANNEL_TOKEN_ENC_KEY;
  if (!encKey) {
    log.error(
      'CHANNEL_TOKEN_ENC_KEY is required to store the page token encrypted. ' +
        'Generate one with `openssl rand -hex 32` and add it to .env.',
    );
    process.exit(1);
  }

  const encrypted = encryptToken(pageToken, encKey);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // channels has no RLS (it IS the tenant-resolution table), but the
    // conversations backfill below is policy-guarded — bind the Masa tenant
    // for this session either way. set_config(..., false) = session-scoped;
    // fine here, the script owns this dedicated connection.
    await client.query(`select set_config('app.tenant_id', $1, false)`, [
      MASA_TENANT_ID,
    ]);

    const upsert = await client.query(
      `INSERT INTO channels (tenant_id, type, page_id, page_access_token_encrypted, status)
       VALUES ($1, 'messenger', $2, $3, 'connected')
       ON CONFLICT (page_id) DO UPDATE
         SET page_access_token_encrypted = EXCLUDED.page_access_token_encrypted,
             status = 'connected'
       RETURNING id, (xmax = 0) AS inserted`,
      [MASA_TENANT_ID, pageId, encrypted],
    );
    const { id: channelId, inserted } = upsert.rows[0] as {
      id: string;
      inserted: boolean;
    };
    log.log(
      `${inserted ? 'Created' : 'Refreshed'} messenger channel for page ${pageId} (channel ${channelId}).`,
    );

    const backfill = await client.query(
      `UPDATE conversations SET channel_id = $1
       WHERE tenant_id = $2 AND channel_id IS NULL`,
      [channelId, MASA_TENANT_ID],
    );
    log.log(
      `Backfilled channel_id on ${backfill.rowCount ?? 0} Masa conversation(s).`,
    );
  } finally {
    await client.end();
  }

  log.log('Done — Masa channel is connected.');
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
