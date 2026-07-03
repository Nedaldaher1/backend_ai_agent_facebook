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

    // --- Model routing (Mastra model-router strings) ---
    // Sales agent — the flagship conversation model. Keep on the flash tier:
    // Jordanian-dialect voice + 11-tool reliability is the product.
    AGENT_MODEL_ID: z.string().default('openrouter/google/gemini-3.5-flash'),
    // Vision extractor — a closed-enum structured-output task; a lite-tier
    // vision model (e.g. openrouter/google/gemini-3.1-flash-lite, ~6x cheaper)
    // handles it. Schema-validated output degrades gracefully on failure.
    VISION_MODEL_ID: z.string().default('openrouter/google/gemini-3.5-flash'),
    // Vision pre-step toggle: any value except 'false' keeps it enabled.
    VISION_ENABLED: z.string().optional(),
    // Vision extraction below this confidence is discarded (attributes: null).
    VISION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.4),
    // Max customer-image download size (bytes) before the vision pre-step bails.
    VISION_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5000000),
    // Timeout (ms) for downloading the customer image from the CDN URL.
    VISION_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    // TTL (ms) for the cached color/size enum lists injected into the vision prompt.
    VISION_ENUMS_TTL_MS: z.coerce.number().int().positive().default(60000),
    // Voice-note transcription pre-step (opt-in: exactly 'true'). Gated in the
    // Messenger webhook controller — flag off reproduces the legacy behavior
    // (audio attachments silently dropped) byte-for-byte.
    TRANSCRIPTION_ENABLED: z.string().optional(),
    // Dedicated audio-understanding model (audio-input chat model via the
    // OpenRouter router — NOT a bare ASR endpoint): one call returns transcript
    // + dialect normalization + confidence as structured output.
    TRANSCRIPTION_MODEL_ID: z
      .string()
      .default('openrouter/google/gemini-3.5-flash'),
    // Transcripts below this confidence are treated as not understood (the
    // deterministic retry/escalation flow takes over).
    TRANSCRIPTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.45),
    // Max voice-note download size (bytes) — the hard cost/latency guard
    // (base64 inflates ~33% into the model call).
    AUDIO_MAX_BYTES: z.coerce.number().int().positive().default(10000000),
    // Timeout (ms) for downloading the voice note from the CDN URL.
    AUDIO_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    // Voice notes longer than this (best-effort mvhd sniff) are refused with a
    // polite "too long" reply instead of being transcribed.
    AUDIO_MAX_DURATION_SEC: z.coerce.number().int().positive().default(180),
    // Cheap-model triage tier for pure greetings/thanks (opt-in: exactly
    // 'true'). See TriageService — strict whitelist; all consequential turns
    // stay on the full agent path.
    TRIAGE_ENABLED: z.string().optional(),
    TRIAGE_MODEL_ID: z
      .string()
      .default('openrouter/google/gemini-3.1-flash-lite'),
    // Never triage texts longer than this many chars (post-normalization).
    TRIAGE_MAX_CHARS: z.coerce.number().int().positive().default(40),
    // Mastra framework logger verbosity (agent steps, tool registration, memory
    // ops) routed through PinoLogger. Per-turn tool-call summaries are logged by
    // AgentService regardless of this. 'silent' disables Mastra's own logs.
    MASTRA_LOG_LEVEL: z
      .enum(['debug', 'info', 'warn', 'error', 'silent'])
      .default('info'),

    // --- Sales-agent generation settings (Mastra modelSettings) ---
    // Tuning knobs forwarded to the model on every sales-agent turn (AI SDK v5
    // CallSettings). Validated here so a misconfigured value fails fast at boot
    // instead of silently becoming NaN / out-of-range at request time. Defaults
    // are the production-tuned values; override per-env without a code change.
    // Sampling temperature [0..2]; lower = more focused/consistent replies.
    AGENT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.5),
    // Nucleus sampling [0..1]. (Provider note: prefer tuning either temperature
    // or topP, not both; Gemini accepts both simultaneously.)
    AGENT_TOP_P: z.coerce.number().min(0).max(1).default(0.8),
    // Hard cap on tokens generated PER STEP (AI SDK v5). This budget must hold the
    // visible Arabic reply (Arabic is ~2-3x more tokens than English) AND any
    // tool-call JSON the step emits (e.g. a multi-item capture_order payload). The
    // old 512 truncated tool calls and long order-confirmation turns, which Gemini
    // surfaced as empty/cut-off replies — so the agent fell silent. 768 holds the
    // observed reply sizes (persona keeps replies short; measured turns emit
    // 200-550 output tokens incl. tool JSON) while still bounding a runaway
    // generation; the empty-reply retry in AgentService is the safety net if a
    // legitimate step ever hits the cap — raise to 1024 if `finishReason=length`
    // shows up on real order turns. Tunable per-env.
    AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(768),
    // Ceiling on tool-calling round-trips per customer message (Mastra maxSteps;
    // its own default is 5). A runaway-loop / cost guard, NOT a primary saver:
    // normal turns stop early on their own, and an order-confirmation turn can
    // legitimately need ~5 steps (check_availability → recommend_size →
    // get_product_for_order → capture_order → reply). Default 6 leaves headroom so
    // real flows are never truncated while still bounding a pathological loop;
    // lower it from the per-turn usage log only if turns are wasting steps.
    AGENT_MAX_STEPS: z.coerce.number().int().positive().default(6),
    // Conversation history kept in every prompt window (Mastra lastMessages).
    // Includes tool-call/result messages whose payloads (product lists, etc.) are
    // re-sent each step — a major lever on per-call size. Was hard-coded to 20;
    // 10 messages is ample for this flow. Tunable per-env.
    AGENT_LAST_MESSAGES: z.coerce.number().int().positive().default(10),
    // Knowledge pre-fetch note caps (RAG injected into context every turn): max
    // FAQ entries and max characters per entry. Bounds the injected note so it
    // can't dominate the prompt; the get_knowledge tool stays available for more.
    AGENT_KNOWLEDGE_MAX_ENTRIES: z.coerce.number().int().positive().default(3),
    AGENT_KNOWLEDGE_MAX_CHARS: z.coerce.number().int().positive().default(500),
    // Knowledge pre-fetch gating. 'gated' (default) injects the FAQ note only
    // when the inbound text looks like an FAQ question (shipping/returns/
    // payment/fabric/sizing/policy keywords) — other turns save its ~300-750
    // tokens and rely on the get_knowledge tool. 'always' = legacy inject-every-
    // turn behavior; 'off' = never inject (tool-only).
    KNOWLEDGE_PREFETCH_MODE: z
      .enum(['always', 'gated', 'off'])
      .default('gated'),
    // Which tools' calls/results are stripped from the RECALLED conversation
    // history before each prompt (Mastra ToolCallFilter). Old product-list and
    // FAQ payloads are the fattest re-sent tokens and are already superseded by
    // working memory + the last-shown recap note. 'fat' strips the seven read
    // tools with big payloads; 'all' strips every tool; 'off' disables filtering
    // (legacy). The CURRENT turn's in-flight tool results are never touched.
    AGENT_HISTORY_TOOL_FILTER: z.enum(['fat', 'all', 'off']).default('fat'),
    // Hard token budget for recalled history per prompt (Mastra
    // TokenLimiterProcessor, estimated tokens). Trims oldest-first while always
    // preserving system messages and the newest messages. 0 disables.
    AGENT_HISTORY_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(12000),
    // Where per-turn dynamic notes (name seed, vision note, knowledge, recap,
    // handoff summary) ride. 'tail' (default) sends them as ONE user-role
    // context message right before the customer's message, keeping the system
    // prefix (instructions + tool schemas) byte-stable so the provider's
    // implicit prompt cache hits (Gemini cache reads bill at 0.1x of input).
    // 'system' = legacy per-note system messages (busts the cache every turn).
    AGENT_CONTEXT_PLACEMENT: z.enum(['tail', 'system']).default('tail'),

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

    // --- Visual search embeddings (gemini-embedding-2 via OpenRouter) ---
    // Multimodal embedding model: images and text map into ONE unified vector
    // space (cross-modal cosine search), reached over OpenRouter's OpenAI-
    // compatible /embeddings endpoint with OPENROUTER_API_KEY. A model swap is a
    // config change + a FULL re-backfill (spaces are incompatible across models).
    EMBEDDING_MODEL_ID: z.string().default('google/gemini-embedding-2'),
    // Embedding dimension. MUST equal the pgvector column and the HNSW index
    // (1536; within pgvector's 2000-dim hnsw cap). Requested via the `dimensions`
    // param; truncated/asserted to this length at runtime.
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
    // Embeddings endpoint (OpenAI-compatible). Override only to point at a proxy.
    EMBEDDING_API_URL: z
      .string()
      .url()
      .default('https://openrouter.ai/api/v1/embeddings'),
    // Per-request timeout (ms), and retries on transient failures (429/5xx/network).
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    EMBEDDING_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    // In-memory cache for query-time embeddings (keyed by input hash). Dedupes
    // the double embed on image turns (knowledge-prefetch resolution + the
    // find_similar_by_image tool embed the SAME image seconds apart) and
    // webhook-retry re-embeds. TTL in ms (0 disables) and max entries (LRU).
    EMBEDDING_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(900000),
    EMBEDDING_CACHE_MAX: z.coerce.number().int().nonnegative().default(200),
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

    // --- Human-like reply pacing (Messenger bubbles) ---
    // Deliver the agent's reply as several short bubbles (split on blank lines)
    // with a typing pause between them, so it reads human. Set to 'false' to send
    // one message (the legacy behavior). Any other value (or unset) = enabled.
    MESSENGER_HUMAN_PACING_ENABLED: z.string().optional(),
    // Typing-simulation speed: delay per character of the next bubble (ms).
    MESSENGER_TYPING_MS_PER_CHAR: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(45),
    // Clamp for the per-bubble typing delay (ms): floor (also used per image).
    MESSENGER_TYPING_MIN_MS: z.coerce.number().int().nonnegative().default(700),
    // Clamp ceiling for the per-bubble typing delay (ms) — keeps the total
    // delivery time bounded even for long replies.
    MESSENGER_TYPING_MAX_MS: z.coerce.number().int().positive().default(2500),
    // Max bubbles per reply; extra paragraphs fold into the last bubble so we
    // never spam the customer.
    MESSENGER_MAX_BUBBLES: z.coerce.number().int().positive().default(4),

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
