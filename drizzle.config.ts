import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for migrations. Entities live per-module under
 * src/modules/<domain>/entities/*.entity.ts, so the schema is a glob.
 * Run: `bunx drizzle-kit generate` then `bunx drizzle-kit migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/**/entities/*.entity.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
