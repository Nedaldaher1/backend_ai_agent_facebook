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
  // Restrict drizzle-kit to the `public` schema for introspect/diff/generate/
  // push. The primary isolation guarantee is structural: Mastra's tables live in
  // a separate `mastra` schema owned by the app user (see src/modules/agent);
  // this filter just ensures drizzle-kit never looks outside `public`.
  schemaFilter: ['public'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
