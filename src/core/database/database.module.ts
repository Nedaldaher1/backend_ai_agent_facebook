import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DRIZZLE } from './drizzle';

/**
 * Global database module. Exposes a single Drizzle client (over a pg Pool)
 * to every module via the DRIZZLE token. Connection string comes from env
 * (DATABASE_URL) — never hard-coded.
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
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
