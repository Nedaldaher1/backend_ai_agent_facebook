# Multi-Tenant Platform Transformation — Phase 0: Audit, Migration Plan & Risk Register

> **Status: awaiting approval.** This is the Phase 0 deliverable required by the build prompt: a complete inventory of every single-tenant assumption in the codebase, the migration plan (from `0020` upward), the risk register, and the phase-by-phase execution strategy. **No production code has been written.** Phases 1–6 start only after this document is approved.
>
> Produced 2026-07-07 from five parallel read-only audits (security/secrets, schema/data-integrity, concurrency/shared-state, agent-runtime correctness, external-integration resilience) plus direct reads of the core wiring. Every load-bearing claim below carries a `file:line` citation into the current `dev` branch.

---

## 0. Executive summary

The transformation is **feasible without an architectural rewrite**. The codebase is well-factored for it: all 11 agent tools are thin adapters that already read identity from a trusted `RequestContext` (never from LLM input), the publish gate (`is_published`) is enforced uniformly at the service layer, and Mastra 1.42 natively supports `instructions`/`model`/`tools` as functions of the per-call `requestContext` — so **one shared agent instance can serve every tenant** with per-tenant persona resolved per call. The webhook already *receives* the natural routing key (`entry[].id` = Facebook page id, validated in the DTO at `messenger-webhook.dto.ts:113`) — it just discards it.

Headline numbers from the audit:

- **16 domain tables**, none with a tenant dimension (`grep -rni "tenant" src` → 0 matches). Migrations run `0000`–`0019`; next is **`0020`** (confirmed via `drizzle/meta/_journal.json`).
- **7 global unique constraints/mechanisms** must be re-scoped per tenant (colors.family, color_synonyms.term, product_categories.slug, products.sku, admin_users.email decision, agent_behavior single-active, plus new conversation uniqueness). The message dedup key is **already tenant-safe** (see §3.9 deviations).
- **5 LLM/embedding call sites** for usage metering; 2 already surface token usage, vision **discards** it, embeddings **never receives** it.
- **14 outbound external call sites**; exactly one has retry/backoff (embeddings). No rate limiting, no circuit breaker, no shutdown hooks.
- **11 concurrency findings (3 blockers)** that are reachable **today** in a single process — the BullMQ split fixes them by construction if we add the atomic-SQL defenses listed in §7.
- **1 showstopper trap**: the app connects to Postgres as the **superuser owner** (`masa`), for which RLS is silently bypassed no matter what policies we write. RLS requires a dedicated non-owner runtime role (§5).

---

## 1. Current-state inventory: every single-tenant assumption

### 1.1 Identity & credentials (env → where they must live)

Full env inventory is in `src/core/config/env.schema.ts` (~72 vars). The ones that change meaning under multi-tenancy:

| Env var | Read at | Multi-tenant home |
|---|---|---|
| `MESSENGER_PAGE_ID` | `messenger.client.ts:73` (Send API URL) | → `channels.page_id` (routing key, globally unique) |
| `MESSENGER_PAGE_ACCESS_TOKEN` | `messenger.client.ts:75` (Bearer), `escalation-notifier.ts:42` (profile fetch) | → `channels.page_access_token_encrypted` (AES-256-GCM at rest) |
| `MESSENGER_APP_SECRET` | `messenger-signature.guard.ts:46` (HMAC) | **stays global** — one Meta app serves all pages |
| `MESSENGER_VERIFY_TOKEN` | `messenger-webhook.controller.ts:101` | **stays global** — one webhook subscription |
| `TELEGRAM_CHAT_ID` | `telegram.client.ts:36` | → per-tenant (`tenants.settings.telegramChatId`), global fallback |
| `TELEGRAM_BOT_TOKEN` | `telegram.client.ts:35` | stays global (one platform bot) for MVP |
| `OPENROUTER_API_KEY`, `JWT_SECRET`, `R2_*`, `DATABASE_URL` | various | stay global (platform-owned) |
| `META_ADS_ACCESS_TOKEN` | **declared but never consumed** (`env.schema.ts:231`, zero call sites) | dead config — remove or park |
| `AGENT_MODEL_ID`, `VISION_MODEL_ID`, `TRIAGE_MODEL_ID`, `TRANSCRIPTION_MODEL_ID`, `EMBEDDING_MODEL_ID` | baked once at boot (`agent.service.ts:324-371`) | stay global for MVP; per-tenant model choice is post-MVP (`tenants.settings`) |
| `TRIAGE_ENABLED`, `TRANSCRIPTION_ENABLED`, vision/knowledge/debounce knobs | baked at boot | global defaults for MVP; per-tenant overrides via `tenants.settings` feature flags (Phase 6) |

**Production fail-fast gate** (`env.schema.ts:302-323`) currently *requires* `MESSENGER_PAGE_ID`/`MESSENGER_PAGE_ACCESS_TOKEN` in production — must be relaxed once channels move to the DB.

### 1.2 Webhook & routing gaps

- Exact order today: raw-body capture (`main.ts:28-32`) → HMAC guard (timing-safe, fail-closed in prod; dev-mode allows when secret unset — `messenger-signature.guard.ts:50-89`) → 200 always (`messenger-webhook.controller.ts:170,185-195`) → async processing. **Correct order for us**: verification stays before any parsing/routing (invariant §3 of the build prompt already holds).
- `entry[].id` (page id) and `recipient.id` are validated in the DTO (`messenger-webhook.dto.ts:113,102`) but **never read**. A single POST can carry entries from **multiple pages**; the loop at `messenger-webhook.controller.ts:202-203` treats them identically.
- The debounce key is bare `psid` (`:232`). PSIDs are **page-scoped** (same string can theoretically map to different humans on different pages), so every PSID-keyed structure must become `(pageId|tenantId, psid)`: debounce buffer, conversation lookup (`conversations.repository.ts:95`), Mastra `resourceId`/`threadId` (`agent.service.ts:445-446`).
- All replies — bot bubbles, carousels, images, `mark_seen`/typing, and **manual staff replies** (`conversation-control.service.ts:430-511`) — go through one `MessengerClient` bound to the single env page (`messenger.client.ts:73-75`). The send path must take a **channel context**.

### 1.3 Data model (16 tables; what must change)

Complete constraint map verified from `src/modules/**/entities/*.entity.ts` + migrations `0000`–`0019`. Migration-relevant facts:

| Item | Today | Change |
|---|---|---|
| `colors_family_idx` UNIQUE(family) | global (`color.entity.ts:50`) | → UNIQUE(tenant_id, family). **Blocker**: per-tenant `__unassigned__` sentinel seed collides on the global unique |
| `color_synonyms_term_idx` UNIQUE(term) | global (`color-synonym.entity.ts:32`) | → UNIQUE(tenant_id, term) |
| `product_categories_slug_idx` UNIQUE(slug) | global (`product-category.entity.ts:112`) | → UNIQUE(tenant_id, slug) |
| `products_sku_idx` UNIQUE(sku) | global (`product.entity.ts:119`) | → UNIQUE(tenant_id, sku) |
| `admin_users_email_idx` UNIQUE(email) | global (`admin-user.entity.ts:33`) | **stays global for MVP** (see §3.9) |
| `agent_behavior` single-active | **code-only**; `setActive()` deactivates ALL other rows with `WHERE id <> :id` (`agent-behavior.repository.ts:80`), `findActive()` unscoped (`:31`) | tenant-scope both queries + partial UNIQUE(tenant_id) WHERE is_active |
| `conversations.psid` | **non-unique** index (`conversation.entity.ts:64`); duplicates tolerated by "most recent wins" (`conversations.repository.ts:95`) | add `channel_id`; UNIQUE(channel_id, psid) after a duplicate-check gate (see §4, migration 0023) |
| `messages` dedup | UNIQUE(conversation_id, external_id) partial (`message.entity.ts:46`) | **keep unchanged** — already tenant-safe via conversation_id |
| Sentinel rows | `__unassigned__` color seeded once globally (migration 0006); `ColorsService.sentinelId` cached **process-wide** (`colors.service.ts:69`); `abaya` category with hard-coded UUID (migration 0017) | per-tenant seeding at tenant creation; per-tenant sentinel cache; fresh category UUID per tenant |
| `orders.tenant_id` derivation | `conversation_id` is nullable + ON DELETE SET NULL (`order.entity.ts:48`) | backfill with constant; **always set at capture time**, never derive from conversation |
| HNSW index | `product_image_embeddings` vector(1536) cosine (migrations 0009/0015) | leave the ANN index untouched; tenant filter goes in the query CTE (`product-image-embeddings.repository.ts:171-196`), not the index |
| `mastra` schema | Mastra-managed tables, same DB, keyed by raw PSID (`mastra.factory.ts:143-147,193`) | outside Drizzle + outside RLS; isolation via key prefixing `${tenantId}:${psid}` (§6.3) |

Backfill derivation matrix (RLS needs `tenant_id` physically on every table; only the backfill *value* is derived):

| Tables | Backfill strategy |
|---|---|
| admin_users, agent_behavior, product_categories, colors, color_synonyms, ad_product_links, products, knowledge_entries, conversations, **orders** | constant `= MASA_TENANT_ID` |
| order_items (via orders), conversation_events + messages (via conversations), product_image_colors/descriptions/embeddings (via products) | `UPDATE … FROM parent` join |

`messages` is the volume table: at Masa's current dev scale a plain transactional backfill is fine; the plan notes the `CONCURRENTLY`/batched upgrade path for real production scale.

### 1.4 Agent runtime (the tenant-threading map)

- **Verdict: singleton-baked agent + dynamic-but-tenant-blind instructions.** `buildMastra()` runs once (`agent.service.ts:379-395`); `instructions: async () => agentBehavior.getInstructions()` (`mastra.factory.ts:253`) is already the function form but takes no arguments and reads the single global active row through a **single-slot 60s cache** (`agent-behavior.service.ts:93`) — under multi-tenancy that cache would serve tenant A's persona to tenant B. Mastra 1.42 passes `{ requestContext }` into dynamic instructions (verified against current Mastra docs), so the fix is: `instructions: async ({ requestContext }) => agentBehavior.getInstructions(requestContext.get('tenantId'))` + a per-tenant cache map.
- **Trusted context**: built at `agent.service.ts:590-634` (keys: `contactId`, `conversationId`, `threadId`, `channel`, `adRef`, `mediaSink`, `lastImageUrl`, `imageLed`, `lastImageText`, `visionAttributes`). Phase 2 adds `tenantId` + `channelId` here — one choke point.
- **All 11 tools** delegate to services; the same repository methods that enforce `is_published` are the cross-tenant leak points because they carry no tenant filter: `ProductsRepository.buildConditions/list/searchFuzzy/findByAdRef/findById/findPublishedBySku` (`products.repository.ts:90-152,155,173,183,274,288`), the ANN CTE (`product-image-embeddings.repository.ts:151-196`), `KnowledgeRepository.findRelevant` (`knowledge.repository.ts:190`), color resolution (`colors.repository.ts`, `color-synonyms.repository.ts`), orders/conversations by id. Phase 2 = add `tenant_id` beside `is_published` in every one of these, plus the tool→service parameter threading.
- **Vision closed-enum vocabulary is global** (`colors.listActiveFamilies`, `products.distinctPublishedAttribute` — `vision.service.ts:73` cache) → must become per-tenant so tenant A's palette doesn't constrain tenant B's vision extraction.
- **Pre-generation pipeline** (normalize → debounce → dedup → transcription → silence gate → triage → vision → notes/RAG) is mapped step-by-step with the queries each stage makes; every stage is conversation-scoped once `findOrCreateByPsid` becomes channel-scoped.

### 1.5 LLM call sites (metering hook points)

| Site | Call | Model env | Usage available? | Today |
|---|---|---|---|---|
| Sales agent | `agent.service.ts:758` (+ retry `:809`) | AGENT_MODEL_ID | ✅ (`normalizeUsage :1218`, summed over retry) | log-only via `formatCostMeta` |
| Triage | `triage.service.ts:112` | TRIAGE_MODEL_ID | ✅ | log-only |
| Vision | `vision.service.ts:139` | VISION_MODEL_ID | ❌ **discarded** (only `.object` read) | none — must extract usage |
| Transcription | `transcription.service.ts:188` | TRANSCRIPTION_MODEL_ID | ✅ | log-only (audio under-priced at text rates) |
| Embeddings | `embedding.service.ts:164` | EMBEDDING_MODEL_ID | ❌ endpoint returns none | none — meter by request count + estimated tokens |

`token-cost.util.ts` is pure (pricing tables + estimate; zero persistence) — the natural seam for a `UsageMeteringService.record()` emit at all five sites.

### 1.6 In-memory state & concurrency (breaks under N instances — several break today)

| State | Where | Redis/BullMQ replacement |
|---|---|---|
| Debounce buffers + timers (Map by psid) | `debounce.service.ts:32-90` | Redis buffer per (tenant, psid) + delayed BullMQ job (deterministic jobId) that re-checks the quiet window on fire |
| Dedup: check-then-act SELECT (`agent.service.ts:471-483`) vs insert seconds later (`:529/:727/:1185/:1599`) | race → **double reply possible today** | atomic claim: `INSERT … ON CONFLICT (conversation_id, external_id) DO NOTHING RETURNING`; only the inserter runs the turn |
| Persona instructions cache (single slot, 60s) | `agent-behavior.service.ts:93` | per-tenant Redis (or Map) + pub/sub invalidation on admin write |
| Vision enums cache (60s) | `vision.service.ts:73,93-95` | per-tenant + invalidation on color/category writes |
| Embedding LRU (TTL 900s) | `embedding.service.ts:53-56` | keep per-process (correctness-safe); optional shared cache later |
| Colors sentinel id cache | `colors.service.ts:69` | per-tenant map (correctness, not just scale) |
| Voice-fail counter RMW on jsonb | `agent.service.ts:496,1598-1626` | atomic SQL increment |

Confirmed **today-bugs** (no queue needed to trigger): `fire()` doesn't await the flush (`debounce.service.ts:79`) so two turns for one PSID can run concurrently → double-reply dedup race, duplicate conversations on first touch (`conversations.service.ts:77-90`, psid non-unique), duplicate draft orders (`orders.service.ts:419-446`, no partial unique), paused→bot double-flip (`agent.service.ts:503-522`), escalate-vs-pause lost update (`conversations.service.ts:162-203` vs `conversation-control.service.ts:252-288`). **Shutdown**: `app.enableShutdownHooks()` is never called (`main.ts`); debounce `onModuleDestroy` clears timers without flushing (`debounce.service.ts:93-98`) — buffered messages are silently lost on redeploy *after* Meta got its 200. Both pg pools (Drizzle + Mastra store) are never closed.

### 1.7 External integrations & failure handling

14 outbound call sites inventoried. Facts that shape Phase 4:

- **Reply is saved before it is sent** (`agent.service.ts:864` inside `handleMessage`; the controller transmits after). Only failure mode is saved-but-not-sent; carousel/images are never persisted at all.
- Multi-bubble send has no per-bubble guard: bubble-2 failure aborts the rest and sends one generic fallback (`messenger-webhook.controller.ts:353-362`).
- Hard LLM failure → escalate-to-human (commit b85682e) — meaning **a transient OpenRouter 429 permanently hands the conversation to a human** and fans out two more external calls (Graph profile + Telegram). A circuit breaker + bounded retries must distinguish transient from hard failure.
- The only retry/backoff in the codebase is embeddings (3 attempts, exp backoff — `embedding.service.ts:161-213`). No inbound rate limit, no outbound Graph throttle, no circuit breaker anywhere.
- Retry multiplication: queue-retry × empty-reply-retry (×2) × maxSteps (≤6) × embedding retries (≤3, and image turns embed twice) — queue `attempts` must stay low (2–3) and app-level retries must be queue-aware.
- Escalation Telegram alert is a voided promise (`conversations.service.ts:194-200`) — staff paging must become a retriable job/outbox.
- SSRF guard's DNS lookup is unbounded (`url-safety.ts:101`) — bound it when it moves into worker jobs.

### 1.8 Auth model

- JWT payload is `{ sub, email, role }` (`auth.service.ts:64-68`) — no tenant claim, no version; 7-day expiry; one secret shared by a sign+verify module (`auth.module.ts:18-29`) and a verify-only module (`security.module.ts:20-25`).
- Guards are per-controller (no global guard); `RolesGuard` is **open-by-default** when `@Roles` is absent (`roles.guard.ts:33-34`) — tenant scoping must not be opt-in.
- `ALLOW_REGISTRATION` creates a tenantless admin (`registration-enabled.guard.ts:26`) — replaced by super-admin provisioning in Phase 6.
- Public routes serving data: `GET /products`, `GET /products/:id` (`products.controller.ts:29,84`) — currently the whole published catalog; under multi-tenancy these become guarded (recommendation §3.9) . Two **empty controller shells** exist at `/orders` and `/conversations` — any route added there would be public by default; remove or guard them in Phase 2.

### 1.9 Non-request entry points needing tenant parameters

`scripts/backfill-embeddings.ts` (walks ALL published products), `scripts/eval-run.ts` (synthetic PSID, no tenant), `scripts/eval-report.ts` (global rows), `DashboardService.getStats` (global aggregates — `dashboard.service.ts:36`), all conversations/orders admin operations (by id, no tenant check). Each gets a `--tenant <slug>` parameter or the authenticated tenant scope.

### 1.10 Documentation drift (fix as we go)

- `CLAUDE.md §2c` still calls the repo a greenfield scaffold — false; also says package manager is Bun, but the repo now runs pnpm + Node (`package.json` scripts, `pnpm-lock.yaml`, `db:init` via `node`). Update in Phase 1.
- CLAUDE.md's Linear examples use `MAS-*`; actual branch history uses the `aia` team key (`feature/aia-22-agent-tools`). Branch names below follow `aia`.

---

## 2. Target architecture (as adopted — deltas from the build prompt called out)

The build prompt's decision table (§2) is adopted as-is: shared DB + `tenant_id` + repository scoping + RLS second layer; modular monolith split into web + worker entrypoints; BullMQ/Redis pipeline; Redis shared state; one App Secret + encrypted per-page tokens; `tenant_id` in trusted requestContext; `platform_users` vs `admin_users` realms; usage_events + usage_daily + Redis quota counters.

Key design confirmations from the audit:

1. **One shared Mastra agent** with `instructions: async ({ requestContext }) => …(tenantId)`; no per-tenant agent instances, no per-tenant model in MVP.
2. **Tenant resolution happens exactly once per inbound**, at the webhook: `entry.id → channels (Redis-cached) → {tenantId, channelId}` — after HMAC, before enqueue. Everything downstream receives `{tenantId, channelId}` in the job payload / requestContext / JWT claim and never re-derives it.
3. **The send path takes a channel context** (page id + decrypted token), used by bot replies, manual staff replies, and the escalation profile lookup.

---

## 3. Data-model migration plan (migrations `0020` → `0024`)

All migrations are additive; none edits an existing file. Drizzle mechanics: update entities → `drizzle-kit generate` for DDL that entities can express, hand-authored SQL (as done in 0004/0006/0011/0017) for backfills/policies — keeping `drizzle/meta` journal + snapshots consistent (`drizzle.config.ts` is `strict: true`).

**Pinned constants** (created in 0020, mirrored as code constants):

```
MASA_TENANT_ID = 'aa5a0000-0000-4000-8000-000000000001'
DEV_PLAN_ID    = 'aa5a0000-0000-4000-8000-000000000002'
```

### 0020 — platform tables + Masa tenant seed

New tables (all money/limits as integers; timestamps timestamptz):

- `tenants(id uuid PK, name text NN, slug text NN UNIQUE, status text NN default 'active' CHECK in (active,suspended,trial), plan_id uuid FK→plans, settings jsonb NN default '{}', created_at)` 
- `plans(id uuid PK, name text NN UNIQUE, monthly_message_limit int, monthly_token_limit bigint, price_micro_usd int NN default 0, features jsonb NN default '{}')`
- `channels(id uuid PK, tenant_id uuid NN FK→tenants ON DELETE CASCADE, type text NN default 'messenger' CHECK in (messenger,whatsapp,instagram), page_id text NN **UNIQUE**, page_access_token_encrypted text NN, status text NN default 'connected' CHECK in (connected,paused,disconnected), connected_at timestamptz NN default now(), meta jsonb NN default '{}')` + index (tenant_id)
- `platform_users(id uuid PK, email text NN UNIQUE, password_hash text NN, role text NN default 'super_admin' CHECK in (super_admin,support), created_at)`
- `usage_events(id uuid PK default gen_random_uuid(), tenant_id uuid NN FK→tenants ON DELETE CASCADE, conversation_id uuid NULL, operation text NN CHECK in (agent,vision,transcription,triage,embedding), model text NN, input_tokens int NN default 0, output_tokens int NN default 0, cached_input_tokens int NN default 0, cost_micro_usd int NN default 0, created_at timestamptz NN default now())` + index (tenant_id, created_at)
- `usage_daily(tenant_id uuid NN FK, day date NN, operation text NN, model text NN, sum_input bigint NN default 0, sum_output bigint NN default 0, sum_cached bigint NN default 0, sum_cost_micro bigint NN default 0, message_count int NN default 0, PRIMARY KEY (tenant_id, day, operation, model))`
- `api_keys(id uuid PK, tenant_id uuid NN FK CASCADE, name text NN, key_hash text NN UNIQUE, prefix text NN, scopes jsonb NN default '[]', last_used_at, revoked_at, created_at)` — defined now, used post-MVP.

Seeds: `plans(DEV_PLAN_ID,'dev-unlimited', NULL, NULL, 0)` and `tenants(MASA_TENANT_ID,'Masa Fashion','masa', 'active', DEV_PLAN_ID)`.

**Deliberately NOT here:** the Masa `channels` row. It needs the real page id + an encrypted token — env-dependent secret material that must not live in static SQL. It is created by an idempotent bootstrap script (below).

### 0021 — add tenant columns (nullable)

`ALTER TABLE … ADD COLUMN tenant_id uuid` on all 16 domain tables; `ALTER TABLE conversations ADD COLUMN channel_id uuid`. Nullable, no FK yet — instant on PG16.

### 0022 — backfill

- Constant backfill (`SET tenant_id = MASA_TENANT_ID`) for: admin_users, agent_behavior, product_categories, colors, color_synonyms, ad_product_links, products, knowledge_entries, conversations, **orders** (never derive orders via its nullable conversation FK).
- Derived backfill (`UPDATE … FROM parent`): order_items←orders, messages/conversation_events←conversations, product_image_colors/descriptions/embeddings←products.
- Post-conditions asserted in-SQL (`DO $$ … RAISE EXCEPTION`): zero NULL `tenant_id` on every table; per-table row counts unchanged.

### 0023 — NOT NULL + FKs + index re-scoping + integrity hardening

- `SET NOT NULL` on `tenant_id` everywhere; `FK → tenants(id) ON DELETE CASCADE`.
- Unique swaps (drop global, create composite): colors `(tenant_id, family)`, color_synonyms `(tenant_id, term)`, product_categories `(tenant_id, slug)`, products `(tenant_id, sku)`.
- New partial unique: `agent_behavior (tenant_id) WHERE is_active` — **preceded by a guard** that asserts at most one active row exists (true for Masa).
- Hot composite indexes: products `(tenant_id, is_published)`, conversations `(tenant_id, psid)`, knowledge_entries `(tenant_id, is_published)`, ad_product_links `(tenant_id, ad_ref) WHERE is_active`, messages `(tenant_id, created_at)`, orders `(tenant_id, status)`, usage indexes per 0020. Old single-column hot indexes dropped where superseded.
- Concurrency hardening (cheap now, required under the queue): partial unique `orders (conversation_id) WHERE status='draft'`; **`conversations (channel_id, psid) UNIQUE` is deferred** to a follow-up migration after the channel backfill script has run (channel_id is still NULL at this point) — the migration adds a plain index now and the unique lands in Phase 3/4 (see §4 bootstrap and §7).
- `messages` dedup unique **left untouched** (already tenant-safe).

### 0024 — RLS

- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (NOT `FORCE` — see §5) on the 16 domain tables.
- One policy per table: `CREATE POLICY tenant_isolation ON <t> USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);` — missing setting ⇒ NULL ⇒ zero rows (fail-closed).
- Conditional GRANTs to the runtime role wrapped in `DO $$ IF EXISTS (SELECT FROM pg_roles WHERE rolname='app_runtime') THEN … END IF $$` so the migration succeeds even before the role exists.
- **Not under RLS** (by design, documented): `tenants`, `plans`, `platform_users`, `api_keys`, `usage_*` (platform-plane; protected by realm auth), and `channels` (it *is* the tenant-resolution table — the webhook must read it before any tenant context exists). The `mastra` schema is Mastra-managed and outside RLS; its isolation is key-prefixing (§6.3).

### Bootstrap script (not a migration): `pnpm tenant:bootstrap-masa`

Idempotent TS script (mirrors `db-init.ts` style): reads `MESSENGER_PAGE_ID` + `MESSENGER_PAGE_ACCESS_TOKEN` + `CHANNEL_TOKEN_ENC_KEY` from env → upserts the Masa `channels` row (by page_id) with the token encrypted (AES-256-GCM, format `v1:<iv>:<tag>:<ct>`) → backfills `conversations.channel_id` for Masa rows. Run once per environment after 0020+; the dev runbook and CI test harness both call it.

### Reversibility

Every step is logically reversible (documented per migration): drop policies → drop composite uniques/restore global ones → drop FKs → drop columns → drop platform tables. No destructive change to existing Masa data at any step; the only data *writes* are additive backfills.

### Migration test (Phase 1 gate)

A real-DB Jest integration test: apply migrations through `0019` (custom runner that walks `drizzle/meta/_journal.json` up to a cut-off), seed a representative single-tenant dataset (products with images/embeddings stub, colors + sentinel, synonyms, categories, knowledge, conversations with messages/events, orders with items incl. one with `conversation_id = NULL`, admin user, active agent_behavior), then apply `0020`–`0024` + bootstrap, and assert: every row carries `MASA_TENANT_ID`; counts preserved; composite uniques exist and the old global ones are gone; `pg_policies` has `tenant_isolation` on all 16 tables; inserting a second tenant's `__unassigned__` color and `abaya` slug now succeeds.

---

## 4. RLS & database-role design (the trap and the fix)

**Trap found by the audit:** the app connects as `masa` — the database **owner** and (in docker-compose) a **superuser** (`docker-compose.yml:21`, `database.module.ts:19-23`). Superusers bypass RLS unconditionally; owners bypass it unless FORCEd. Any policy we write would be a silent no-op for the current connection.

**Design:**

- Two roles, two URLs:
  - `masa` (owner) — migrations + `db-init` only. Env: `DATABASE_URL_MIGRATIONS` (falls back to `DATABASE_URL` if unset, dev convenience).
  - `app_runtime` — LOGIN, non-superuser, non-owner; `GRANT SELECT/INSERT/UPDATE/DELETE` on domain tables + `USAGE` on schema/sequences. The app's `DATABASE_URL` points here. Because it doesn't own the tables, plain `ENABLE ROW LEVEL SECURITY` binds it — **no FORCE needed**, and the owner keeps unimpeded access for migrations/backfills.
- Role creation is **not** a migration (roles are cluster-level; passwords are secrets): `db-init.ts` gains an idempotent `ensureAppRole()` step (dev), and the production runbook documents the one-time `CREATE ROLE`.
- Per-unit-of-work tenant binding: a `withTenant(tenantId, fn)` helper opens a Drizzle transaction and runs `SELECT set_config('app.tenant_id', $1, true)` (transaction-local — safe under pooling), exposed via AsyncLocalStorage:
  - HTTP: a Nest interceptor binds it after JWT/tenant resolution (admin routes) — tenant from the token claim.
  - Worker: the job wrapper binds it from the job payload.
  - Webhook channel lookup and platform-realm queries run *outside* tenant context (channels/platform tables are not under RLS).
- **Enforcement order**: repository-level `WHERE tenant_id = ?` (threaded explicitly, Phase 2) is the primary layer on every path and is what the isolation tests assert; RLS is the second net that turns any forgotten filter into **zero rows instead of a leak**. Dev compose switches the app to `app_runtime` so RLS is actually exercised during development, and a readiness check warns if the runtime connection is a superuser/owner in production.
- Mastra's `PostgresStore` keeps using the owner URL? **No** — it also moves to `app_runtime` (needs full DML on the `mastra` schema, granted broadly; no RLS there).

---

## 5. Phase-by-phase execution plan

Branch per phase off `dev` (`feature/aia-<n>-…` once Linear issues exist; otherwise `feature/multi-tenant-phase<k>-…`). Every phase ends with: `pnpm build` + `pnpm test` (+ `test:e2e` where flows change) + `pnpm lint` green, `backend-code-reviewer` pass, **and a Masa end-to-end smoke in dev mode**. Squash/FF into `dev`.

### Phase 1 — Tenancy foundation (data model)
Migrations 0020–0024 + entities updated (`tenants`, `channels`, … + `tenantId` columns on all 16 entity files) + `crypto.util` (AES-256-GCM encrypt/decrypt) + `ensureAppRole()` in db-init + bootstrap script + the **real-DB test harness** (new `test/integration` Jest project against docker-compose PG) + the migration test above. Masa impact: none at runtime — code still ignores `tenant_id`; DB now carries it. CLAUDE.md corrections (§1.10) land here.

### Phase 2 — Tenant-scoped domain layer (the correctness gate)
- Thread `tenantId` explicitly through every repository/service listed in §1.4/§1.9 (products, colors+synonyms+sentinel logic, categories, ad links, knowledge, conversations, orders, dashboard, admin CRUD, agent_behavior incl. the `setActive` cross-tenant fix and per-tenant instruction cache, vision enums per tenant).
- Trusted context: `requestContext.set('tenantId'|'channelId', …)` at `agent.service.ts:590`; all 11 tools pass it into service calls; Mastra keys become `${tenantId}:${psid}` / `thread:${tenantId}:${psid}` + a one-shot remap script for existing Masa `mastra` rows.
- JWT gains `tenantId` claim + a `TenantGuard` (mandatory, not opt-in); login scoped; existing tokens invalidated (one forced re-login).
- Public catalog routes move behind auth; empty `/orders` + `/conversations` controller shells removed.
- `withTenant` interceptor wired for admin routes; agent path binds it in `handleMessage`.
- **Isolation test matrix** (real DB, two seeded tenants): every tool × cross-tenant probe returns empty/denied; every admin endpoint × foreign-id probe → 404; raw `app_runtime` probes per table under wrong/absent `app.tenant_id` → zero rows. Masa impact: behavior identical (single tenant present); the full regression suite + eval smoke proves it.

### Phase 3 — Webhook routing + per-page sending
- Webhook: per-entry loop resolves `entry.id → channel` (in-process cache first; Redis in Phase 4); unknown page → log + count + skip; `recipient.id` cross-checked; debounce key becomes `(channelId, psid)`.
- `MessengerClient` takes a channel context (page id + token decrypted on demand); manual staff reply + escalation profile lookup use the conversation's channel; Telegram target per tenant with global fallback; prod env gate relaxed (`env.schema.ts:302-323`).
- `conversations.channel_id` enforced for new rows; duplicate-psid check + `UNIQUE (channel_id, psid)` migration lands here; super-admin "subscribe page" Graph call (`POST /{page-id}/subscribed_apps`) implemented but exercised in Phase 6.
- Masa gate: full dev-mode round trip through the tunnel — message in → routed by page id → reply sent with the **DB token**, env token path deleted.

### Phase 4 — Scalability layer
- Add Redis + BullMQ (`bullmq`, `@nestjs/bullmq`, `ioredis`; docker-compose gains `redis:7`); split entrypoints `main.ts` (web) / `worker.ts` (worker) over the same module graph; `start:web` / `start:worker` scripts.
- Pipeline: webhook verifies → resolves channel → `LPUSH` message to Redis buffer → ensures a delayed `turn` job (deterministic jobId `turn:{tenant}:{psid}`); the job re-checks the quiet window (re-enqueues itself for the remainder if a newer message arrived, respecting the 8s cap), then drains the buffer and runs the turn. Per-conversation serialization: Redis lock `lock:turn:{tenant}:{psid}` (TTL + renewal; contention → delayed re-enqueue).
- Atomicity hardening (from §1.6, all small SQL changes): dedup claim via `ON CONFLICT … RETURNING`; conditional auto-resume; state-transition guards (`WHERE ai_state = expected … RETURNING`); atomic voice-fail increment; outbox-style send step (persisted outbound + `sent` flag keyed by inbound mid) so a job retry re-attempts only undelivered sends — never a duplicate reply.
- Redis-backed caches with pub/sub invalidation (persona, vision enums, channel lookup); per-page outbound token bucket in front of `postToSendApi`; low queue `attempts` (2–3) + exp backoff + DLQ; escalation notify becomes a retriable job; OpenRouter circuit breaker + transient/hard failure distinction (transient ⇒ retry/delay, only hard ⇒ escalate).
- `enableShutdownHooks()` + graceful drain (stop intake, close worker awaiting active jobs, flush buffers, `pool.end()` + Mastra store close); `/healthz` (liveness) + `/readyz` (PG + Redis + role sanity); pino request-scoped `tenant_id`/`request_id`/`conversation_id` bindings; minimal Prometheus metrics (queue depth, turn latency, LLM latency/tokens, send errors); pool sizing + statement timeouts on the pg Pool.
- Masa gate: kill -TERM under load loses zero buffered messages; duplicate webhook delivery produces exactly one reply.

### Phase 5 — Usage metering + quotas
- `UsageMeteringService.record()` at the five call sites (§1.5): vision starts extracting usage; embeddings metered as request-count + estimated tokens; cost via the existing pricing tables → `cost_micro_usd` int. Events written via a `usage` queue (never in the reply path).
- Rollup: repeatable BullMQ job aggregating `usage_events` → `usage_daily` upsert (idempotent re-aggregation of the current + previous day).
- Quota: Redis counters `usage:{tenant}:{yyyymm}:messages|tokens` incremented per turn; guard before generate; exceed ⇒ per-plan action (pause tenant agent + notify super-admin); **fail-open on Redis outage** (never silence sales because the meter is down), logged loudly.

### Phase 6 — Super-admin API + auth (MVP demo-ready at the end)
- Platform realm: `PLATFORM_JWT_SECRET`, separate login, guards that reject cross-realm tokens; `platform_users` seeding script.
- Endpoints: tenants CRUD + suspend + plan assignment (+ per-tenant feature flags in `tenants.settings`); channels connect (dev-mode manual page_id + token → encrypt → subscribe via Graph) / disconnect / status; cross-tenant analytics from `usage_daily` (tokens/cost per tenant/model/day, top tenants, near-limit); impersonation (scoped tenant context + audit log rows for every sensitive action).
- Tenant provisioning creates the per-tenant seeds (sentinel color, default category, default persona row) — replacing the global-singleton assumptions found in §1.3.
- `ALLOW_REGISTRATION` retired in favor of super-admin staff provisioning.

Phases 7 (public API keys) and 8 (OAuth onboarding) remain post-MVP as scoped in the build prompt; `api_keys` table and the `channels` abstraction already accommodate them.

---

## 6. Test strategy

1. **New real-DB integration harness** (Phase 1): separate Jest project (`test/integration/jest-integration.json`) against the docker-compose Postgres; per-run scratch database (`masa_test_<run>`), migrations applied, seeded fixtures; wired into the phase gates. (Today's tests are unit/mocked + one health e2e — insufficient for isolation/RLS proofs.)
2. **Migration test** (Phase 1): §3 above — backfill integrity + constraint swaps + policy presence.
3. **Isolation matrix** (Phase 2, grows every later phase): tools × tenants, admin API × foreign ids, RLS probes per table, webhook routing × unknown/foreign pages (Phase 3), queue jobs carrying wrong tenant (Phase 4), quota counters per tenant (Phase 5), realm-crossing tokens (Phase 6).
4. **Masa non-regression per phase**: full unit suite + integration suite + a scripted dev-mode webhook round trip (signed payload → routed → reply from Masa catalog via Masa channel token). The existing `eval:run` harness (tenant-parameterized in Phase 2) remains the retrieval-quality check.
5. **Concurrency tests** (Phase 4): duplicate-delivery → exactly-one reply; SIGTERM drain; per-conversation ordering under parallel workers.

---

## 7. Risk register (ranked)

| # | Risk | Likelihood → Impact | Mitigation (phase) |
|---|---|---|---|
| R1 | RLS silently bypassed (app connects as owner/superuser) | certain today → isolation theater | `app_runtime` role + two URLs + readiness assert + RLS probe tests (P1/P2) |
| R2 | Cross-tenant persona/vision-enum bleed via single-slot caches | high once 2 tenants exist → wrong brand voice | per-tenant caches + pub/sub invalidation + isolation tests (P2/P4) |
| R3 | Sentinel-color triple bug (global unique + process cache + unscoped queries) breaks tenant #2 creation and safe-delete | certain at tenant #2 → broken catalog ops | fix trio together + per-tenant seeding in provisioning + migration test (P1/P2/P6) |
| R4 | Mastra memory bleed / orphaning: PSID-keyed resource/thread across pages; existing Masa threads orphaned by key change | medium → privacy leak / memory loss | tenant-prefixed keys + one-shot remap script for Masa rows (P2) |
| R5 | `setActive` deactivates every tenant's persona | certain once shared → cross-tenant sabotage | tenant-scoped WHERE + partial unique (P1/P2) |
| R6 | Queue split causes duplicate replies / duplicate orders / duplicate escalation pages | high under retries → customer-visible | turn-claim row, outbox send, per-conversation lock, transition guards, draft partial-unique (P4, index in P1) |
| R7 | Backfill misses rows (orders with NULL conversation; late-arriving rows during migration) | low–medium → NOT NULL failure or mis-tenanted rows | constant backfill for orders; in-migration assertions; migration test; dev-window execution (P1) |
| R8 | Existing admin JWTs (7d) lack tenant claim after Phase 2 | certain → one-time lockout | forced re-login, announced; guards reject cleanly (P2) |
| R9 | Transient LLM failure permanently escalates conversations; retry storms amplify (queue × app retries × steps) | medium → staff flood + cost spikes | circuit breaker, transient/hard distinction, low queue attempts, per-page throttle (P4) |
| R10 | Multi-page webhook batches mis-routed; unknown pages crash or spam | medium → wrong-tenant replies (worst-case) | per-entry routing + recipient cross-check + unknown-page drop path + routing tests (P3) |
| R11 | Redis becomes a hard dependency (debounce/queue/quota) | medium → outage = no replies | readyz gating + Meta retry semantics (never 200-and-drop), quota fail-open, runbook (P4/P5) |
| R12 | `conversations (channel_id, psid)` unique blocked by legacy duplicate PSIDs | low (dev-scale data) → migration halt | pre-assert + documented merge script fallback; unique deferred until after channel backfill (P3) |
| R13 | Hand-authored SQL drifts from Drizzle snapshots (`strict: true`) | medium → future generate breaks | entities updated first, `drizzle-kit generate` for DDL, snapshot check in CI (P1) |
| R14 | Per-tenant instructions change the byte-stable prompt prefix assumptions (Gemini implicit cache) | low → cost regression only | prefix is stable *per tenant* (cache is keyed by content); keep tail-context placement; watch cache-hit metric (P2/P5) |
| R15 | Decrypted page tokens leak into logs once they flow through send/job paths | low → severe | keep header-not-URL discipline, no token fields on job payloads (channel **id** only, decrypt at send), lint/log review in code review gate (P3/P4) |

---

## 8. Open decisions (approval needed / defaults I will apply)

Adopted-unless-you-object (each deviates from or extends the build prompt, with audit-based rationale):

1. **`messages` dedup key stays `(conversation_id, external_id)`** — already tenant-safe via the conversation FK; the prompt's `(tenant_id, dedup_key)` would be redundant. (§1.3)
2. **`conversations` gains `channel_id`** (beyond the prompt's list) — PSIDs are page-scoped and every reply (bot + human) must know which page token to use. Uniqueness target is `(channel_id, psid)`, not `(tenant_id, psid)`. (§1.2)
3. **`admin_users.email` stays globally unique in MVP** — per-tenant email + tenant-picking login is a post-MVP relaxation; staff are provisioned by the super-admin anyway. (§1.8)
4. **RLS = `ENABLE` (not `FORCE`) + dedicated non-owner `app_runtime` role + two DB URLs** — FORCE would subject the migration owner to policies; a non-owner runtime role is the correct binding. (§4)
5. **RLS scope = the 16 domain tables only** — `channels` is the tenant-resolution table (read pre-tenant-context) and platform tables are realm-guarded. (§3, 0024)
6. **Masa channel row is created by an idempotent bootstrap script, not a migration** — no secrets/env-dependent values in static SQL. (§3)
7. **Existing Masa Mastra memory is remapped** (SQL key-prefix update) rather than reset — cheap, preserves customer working memory. Fallback: accept reset (dev data). (§5 Phase 2)
8. **Public `GET /products` + `GET /products/:id` move behind tenant-admin auth** — no storefront consumes them today; re-exposure comes back with Phase 7 API keys. Flag now if the admin panel calls them unauthenticated.
9. Per-tenant **model ids and feature flags** ride in `tenants.settings` with global env defaults (triage/transcription flags become per-tenant in Phase 6; model choice stays global in MVP).

**The one question that gates execution: approve this plan (with the nine defaults above) so Phase 1 can start?**

---

## 9. Acceptance mapping (build-prompt DoD → where it lands)

| DoD item | Delivered by |
|---|---|
| 1. Masa runs as tenant, zero regression | P1 migration + per-phase Masa gate + migration test |
| 2. Super-admin creates tenant, connects page, enables agent | P6 (provisioning + channels + flags) |
| 3. Page-routed turn: tenant catalog, tenant persona, tenant token | P2 (scoping) + P3 (routing/sending) |
| 4. Isolation proven by tests | P2 isolation matrix, extended P3–P6 |
| 5. Web + worker processes over a durable queue with retries | P4 |
| 6. Every LLM call metered per tenant; dashboard + real-time quota | P5 (+ P6 dashboard) |
| 7. Green tests incl. isolation + migration tests | harness P1; gates every phase |

## Appendix A — new/changed env

`DATABASE_URL` (now the `app_runtime` connection), `DATABASE_URL_MIGRATIONS` (owner; dev fallback = DATABASE_URL), `REDIS_URL`, `CHANNEL_TOKEN_ENC_KEY` (32-byte hex), `PLATFORM_JWT_SECRET`; retire from prod-required: `MESSENGER_PAGE_ID`, `MESSENGER_PAGE_ACCESS_TOKEN`; remove dead `META_ADS_ACCESS_TOKEN`. docker-compose gains a `redis:7-alpine` service; `db-init` gains `ensureAppRole()`.
