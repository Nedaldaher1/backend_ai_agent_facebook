import { z } from 'zod';

/**
 * Single source of truth for environment variables. Validated once at
 * bootstrap so the app fails fast on a missing/invalid secret.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Comma-separated browser origins allowed to call the API (CORS). Optional in
    // local dev (any localhost port is auto-allowed); set it in production to the
    // admin panel origin(s), e.g. 'https://admin.masafashion.com'.
    CORS_ORIGINS: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // LLM provider key. Every model call (sales agent + vision) routes through
    // OpenRouter via Mastra's model router, which reads OPENROUTER_API_KEY.
    OPENROUTER_API_KEY: z.string().min(1),
    // Legacy Anthropic-direct key. Optional now that OpenRouter is the default
    // provider; only needed if a *_MODEL_ID is pointed back at 'anthropic/...'.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Storage driver selection. 'fs' uses the local filesystem (dev only);
    // 'r2' uses Cloudflare R2 via the S3-compatible API (production).
    STORAGE_DRIVER: z.enum(['fs', 'r2']).default('r2'),
    // Local directory the `fs` driver writes to (created on boot, gitignored).
    UPLOAD_DIR: z.string().default('./uploads'),
    // Public base URL for this server. Used by the `fs` storage driver to build
    // image URLs sent to the admin panel:
    //   `${PUBLIC_BASE_URL}/uploads/<filename>`
    // In production set this to the deployed API domain.
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
    // Max upload size per file, in bytes (default 5 MiB).
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    // Auth: secret for signing admin JWTs + token lifetime (e.g. '7d', '12h').
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d'),
    // Admin self-registration gate (WS0). POST /auth/register is CLOSED unless
    // this is exactly 'true'. Open it only to bootstrap the first admin (there is
    // no seed mechanism), then set it back. Any other value (incl. unset) → 403.
    ALLOW_REGISTRATION: z.string().optional(),

    // --- Visual search embeddings (Marqo-FashionSigLIP via Transformers.js) ---
    // Multimodal model id; images and text embed into one 768-d space. A model
    // swap is a config change + re-backfill, never a code edit.
    EMBEDDING_MODEL_ID: z.string().default('Marqo/marqo-fashionSigLIP'),
    // Embedding dimension. MUST equal the model output, the pgvector column, and
    // the HNSW index — all 768 for fashionSigLIP. Asserted at runtime.
    EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
    // ONNX weight dtype. fp32 = best retrieval quality; q8 = smaller/faster. The
    // SAME dtype must be used for catalog and query embeddings, so it is one knob.
    EMBEDDING_DTYPE: z
      .enum(['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4'])
      .default('fp32'),
    // Writable, persistent dir for downloaded model files (Transformers.js cache).
    TRANSFORMERS_CACHE_DIR: z.string().default('./.cache/transformers'),
    // Default number of distinct products visual search returns.
    SIMILARITY_TOP_K: z.coerce.number().int().positive().default(6),
    // Minimum cosine similarity [0..1] a match must clear to be surfaced; below
    // it the agent gets an empty result and must not invent products.
    SIMILARITY_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.6),

    // Debounce window: how long to wait for additional messages from the same
    // subscriber before flushing the batch to the agent (milliseconds).
    DEBOUNCE_WINDOW_MS: z.coerce.number().int().positive().default(2000),
    // Hard maximum wait time for the debounce regardless of new messages
    // arriving (milliseconds). Keep well below Meta's webhook 20-second timeout.
    DEBOUNCE_MAX_MS: z.coerce.number().int().positive().default(8000),

    // --- Meta Messenger Platform (direct Graph API, v25.0) ---
    // Token echoed during webhook verification (GET /webhook/messenger):
    // hub.verify_token must equal this. You choose the value and set the same
    // string in the Meta App dashboard webhook config. Required in production.
    MESSENGER_VERIFY_TOKEN: z.string().optional(),
    // App Secret (Meta App → Settings → Basic). Validates the X-Hub-Signature-256
    // HMAC on every inbound POST. Required in production.
    MESSENGER_APP_SECRET: z.string().optional(),
    // The Facebook Page id this app sends from (POST /{PAGE_ID}/messages).
    MESSENGER_PAGE_ID: z.string().optional(),
    // Long-lived Page access token (Meta App → Messenger → Generate token).
    // Authorizes Send API calls. Required in production.
    MESSENGER_PAGE_ACCESS_TOKEN: z.string().optional(),
    // Graph API version — the SINGLE pin for every Graph call. Bump here only.
    MESSENGER_GRAPH_VERSION: z.string().default('v25.0'),
    // Optional ads token to resolve ad_id → name/adset/campaign for attribution.
    META_ADS_ACCESS_TOKEN: z.string().optional(),

    // --- Cloudflare R2 (required when STORAGE_DRIVER='r2') ---
    // Account ID (encoded in the endpoint; included here for documentation).
    R2_ACCOUNT_ID: z.string().optional(),
    // S3-compatible credentials.
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    // Bucket name.
    R2_BUCKET: z.string().optional(),
    // S3 API endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    R2_ENDPOINT: z.string().url().optional(),
    // Public CDN / bucket URL for serving objects (set in R2 dashboard).
    // getUrl(key) returns `${R2_PUBLIC_URL}/${key}`.
    R2_PUBLIC_URL: z.string().url().optional(),
    // R2 does not use real AWS regions; 'auto' is the correct value.
    R2_REGION: z.string().default('auto'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER !== 'r2') return;

    // When the driver is r2 every R2_* variable (except R2_REGION, which has a
    // default) is required. addIssue with the matching path so the fail-fast
    // error message names the exact missing variable.
    const required: Array<keyof typeof env> = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_PUBLIC_URL',
    ];
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Required when STORAGE_DRIVER is 'r2'`,
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // The direct Messenger transport cannot run without these secrets. Fail fast
    // in production so a misconfigured deploy never silently drops messages. In
    // dev/test they stay optional (the webhook is exercised via tests/tunnel).
    const required: Array<keyof typeof env> = [
      'MESSENGER_VERIFY_TOKEN',
      'MESSENGER_APP_SECRET',
      'MESSENGER_PAGE_ID',
      'MESSENGER_PAGE_ACCESS_TOKEN',
    ];
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Required when NODE_ENV is 'production'`,
        });
      }
    }
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
