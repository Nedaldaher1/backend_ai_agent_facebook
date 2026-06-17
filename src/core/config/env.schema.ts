import { z } from 'zod';

/**
 * Single source of truth for environment variables. Validated once at
 * bootstrap so the app fails fast on a missing/invalid secret.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  // Storage (product image uploads). flydrive is isolated in src/core/storage;
  // switching the fs driver for s3/r2/gcs is a config + driver change there only.
  STORAGE_DRIVER: z.string().default('fs'),
  // Local directory the `fs` driver writes to (created on boot, gitignored).
  UPLOAD_DIR: z.string().default('./uploads'),
  // Base URL that stored image URLs are built from (must reach this server).
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Max upload size per file, in bytes (default 5 MiB).
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return parsed.data;
}
