import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DatabaseRoleCheck } from './database-role-check';
import { DRIZZLE } from './drizzle';

/**
 * Global database module. Exposes a single Drizzle client (over a pg Pool)
 * to every module via the DRIZZLE token. Connection string comes from env
 * (DATABASE_URL) — never hard-coded. DATABASE_URL must point at the non-owner
 * app_runtime role so RLS binds (DatabaseRoleCheck warns loudly otherwise);
 * the owner role lives on DATABASE_URL_MIGRATIONS for db-init/migrations.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
        });
        return drizzle(pool);
      },
    },
    DatabaseRoleCheck,
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
