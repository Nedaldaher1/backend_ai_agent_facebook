import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from './drizzle';

/**
 * Boot-time RLS sanity check. Row-Level Security is silently BYPASSED when the
 * connection role is a superuser (always) or the table owner (unless FORCE).
 * The app must therefore connect as the non-owner app_runtime role; this check
 * makes a mis-pointed DATABASE_URL loud instead of quietly disabling every
 * tenant-isolation policy. Warn-only in Phase 1 (single tenant); the Phase 4
 * readiness probe turns it into a hard production gate.
 */
@Injectable()
export class DatabaseRoleCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseRoleCheck.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = (await this.db.execute(sql`
        select
          current_user as role,
          (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
          (select count(*)::int from pg_tables
             where schemaname = 'public' and tableowner = current_user) as owned_tables
      `)) as unknown as {
        rows: Array<{
          role: string;
          is_superuser: boolean;
          owned_tables: number;
        }>;
      };
      const row = result.rows[0];
      if (!row) return;
      if (row.is_superuser || row.owned_tables > 0) {
        this.logger.warn(
          `DATABASE_URL connects as "${row.role}" (superuser=${String(
            row.is_superuser,
          )}, owns ${row.owned_tables} public tables) — RLS tenant isolation is BYPASSED ` +
            'for this role. Point DATABASE_URL at the app_runtime role (pnpm db:init creates it) ' +
            'and keep the owner role on DATABASE_URL_MIGRATIONS.',
        );
      } else {
        this.logger.log(
          `Database role "${row.role}" is non-owner/non-superuser — RLS policies bind. ✓`,
        );
      }
    } catch (err) {
      this.logger.warn(`Database role check failed: ${String(err)}`);
    }
  }
}
