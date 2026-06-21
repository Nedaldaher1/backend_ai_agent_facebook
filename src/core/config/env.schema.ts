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
    ANTHROPIC_API_KEY: z.string().min(1),
    // Storage driver selection. 'fs' uses the local filesystem (dev only);
    // 'r2' uses Cloudflare R2 via the S3-compatible API (production).
    STORAGE_DRIVER: z.enum(['fs', 'r2']).default('r2'),
    // Local directory the `fs` driver writes to (created on boot, gitignored).
    UPLOAD_DIR: z.string().default('./uploads'),
    // Public base URL for this server. Serves two purposes:
    //  1. `fs` storage driver: image URLs sent to the admin panel and to ManyChat
    //     are built as `${PUBLIC_BASE_URL}/uploads/<filename>`.
    //  2. ManyChat webhook URL in dev: copy the cloudflared tunnel HTTPS URL here
    //     and paste the same URL into the ManyChat External Request block, e.g.
    //     https://<tunnel-id>.trycloudflare.com/webhook/manychat
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

    // --- ManyChat integration ---
    // API token for the Send API (async path: POST /fb/sending/sendContent).
    // Generate in ManyChat → Settings → API → Create API Key.
    MANYCHAT_API_TOKEN: z.string().optional(),
    // Send API endpoint. Override only if ManyChat changes the URL; the default
    // is the documented production endpoint.
    MANYCHAT_SEND_URL: z
      .string()
      .url()
      .default('https://api.manychat.com/fb/sending/sendContent'),
    // Set to 'false' to disable all outgoing ManyChat Send API calls (e.g.
    // during testing). Any other value (or omitting the var) means enabled.
    MANYCHAT_ENABLED: z.string().optional(),
    // Public API base URL. Both the Send API and the Public API share the same
    // account token under api.manychat.com; override only if ManyChat changes it.
    MANYCHAT_API_BASE: z
      .string()
      .url()
      .default('https://api.manychat.com'),
    // Name of the ManyChat custom field that mirrors the agent's ai_state value
    // (bot | human | paused). Create this field in ManyChat → Custom Fields.
    MANYCHAT_AI_STATE_FIELD: z.string().default('ai_state'),
    // ManyChat tag applied to subscribers whose conversation is handled by a
    // human agent. Used to filter inboxes in ManyChat. Create the tag first.
    MANYCHAT_HUMAN_TAG: z.string().default('ai_human'),
    // Optional: flow namespace (flow_ns) of a ManyChat flow that pauses
    // automation for the subscriber. Triggered on escalation / manual pause.
    MANYCHAT_PAUSE_FLOW_ID: z.string().optional(),
    // Optional: flow namespace (flow_ns) of a ManyChat flow that resumes
    // automation for the subscriber. Triggered when the admin marks a
    // conversation back to 'bot' state.
    MANYCHAT_RESUME_FLOW_ID: z.string().optional(),
    // Shared secret checked on every inbound webhook request via the
    // x-manychat-secret header. Set in ManyChat → Flow → External Request →
    // Custom Headers. When unset, the guard logs a warning and allows the
    // request (dev-friendly). Required in production.
    WEBHOOK_SHARED_SECRET: z.string().optional(),
    // Debounce window: how long to wait for additional messages from the same
    // subscriber before flushing the batch to the agent (milliseconds).
    DEBOUNCE_WINDOW_MS: z.coerce.number().int().positive().default(2000),
    // Hard maximum wait time for the debounce regardless of new messages
    // arriving (milliseconds). Must be < ManyChat's 10-second timeout.
    DEBOUNCE_MAX_MS: z.coerce.number().int().positive().default(8000),

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
