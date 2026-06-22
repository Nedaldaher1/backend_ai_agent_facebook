# Backend Audit & Hardening Report

**Scope:** Full backend audit of the Masa Fashion AI-agent (NestJS + Fastify + Bun + Drizzle + PostgreSQL + Mastra + Claude + ManyChat) across the Vision pipeline, eval/guardrail, idempotency, the ManyChat adapter + Send API + Public-API control service, the async debounce worker, the evals harness, the conversation-control / human-handoff system + reply gate + self-healing resume, and the Drizzle/Postgres data layer.

**Method:** Five read-only auditors (concurrency, resilience, data-integrity, correctness, security) scanned the tree; every finding below was then re-validated by the orchestrator against the real source before inclusion. Both *confirmed bugs* (defects in code as written) and *anticipated failures* (unhandled production scenarios) are reported.

**Branch:** `feature/AIA-audit-backend` (cut from `feature/AIA-34-conversation-control`, which carries all subsystems under audit). Linear: intentionally skipped per request. **No `git push`. No migration applied.**

**Audit phase mutated nothing.** Fixes are applied only in the gated fix cycle (§ Fix plan).

---

## Severity / type summary (deduplicated)

| Subsystem | blocker | should-fix | nit |
|---|---|---|---|
| Agent turn / reply gate / handoff | 1 | 2 | 1 |
| Conversation control & state | 0 | 2 | 1 |
| ManyChat adapter / sender / async worker | 2 | 3 | 1 |
| Idempotency & concurrency | 0 | 3 | 2 |
| Vision & visual search | 1 (SSRF) | 1 | 1 |
| Data layer / schema / migrations | 0 | 2 | 3 |
| Security / auth / input | 1 | 2 | 2 |

Status tags: **[FIX NOW]** applied in this pass · **[REC]** recommendation awaiting go-ahead · **[STOP]** scope-guard stop (fix specified, not applied).

---

## 1. Agent turn / reply gate / handoff — `agent.service.ts`

### Confirmed bugs

**A1 · [blocker] [confirmed-bug] Timed pause never auto-resumes — `pausedUntil` is written but never read · [FIX NOW]**
- location: gate at `agent.service.ts:263` (checks only `convo.aiState !== 'bot'`); `pausedUntil` written at `conversation-control.service.ts:146-156`; cleared only by manual `resume()` (`:196`). No scheduler reads it (no `@Cron`/`setInterval` anywhere).
- scenario: an admin pauses with `durationMinutes` (e.g. 30). After the window elapses, the next inbound message still sees `ai_state='paused'` and nothing compares `pausedUntil` to now.
- impact: a *temporary* pause becomes **permanent silence** — the bot never replies again until a human manually resumes. The `durationMinutes` API (and its ≤1440 validation) is effectively dead. Independently found by 3 auditors.
- fix: in `handleMessage`, before the gate, if `aiState==='paused' && pausedUntil <= now` → flip to `bot` (clear `pausedUntil`, record a `resume`/`system` event, mirror `bot` to ManyChat) and let the turn proceed.

**A2 · [should-fix] [confirmed-bug] One-shot `humanSummary` is cleared BEFORE `generate()`; lost if the turn throws · [FIX NOW]**
- location: inject + fire-and-forget clear at `agent.service.ts:329-339`; `generate()` at `:357`.
- scenario: after an admin resume with a wrap-up `summary`, the next customer turn injects the summary then immediately calls `clearHumanSummary` (not awaited), then `generate()` throws (Claude 429/5xx/401).
- impact: the summary is already cleared but the model never consumed it; on retry `humanSummary` is null, so the human-handoff context is **permanently lost** — defeats the WS7 "injected once into the next *successful* turn" intent.
- fix: clear the summary only AFTER a successful `generate()` (move the `clearHumanSummary` call past `:361`).

### Anticipated failures

**A3 · [should-fix] [anticipated-failure] Concurrent post-resume turns can inject `humanSummary` twice · [REC]**
- location: `agent.service.ts:329-339` (read `humanSummary` → inject → async clear, no atomic claim).
- scenario: two turns for the same contact run close together right after resume; both read the summary before the async clear commits.
- impact: handoff summary fed to the model more than once (token waste, repeated "re-learning"). Lower frequency than A2.
- fix: clear-and-claim atomically (`UPDATE … SET human_summary=NULL WHERE id=? AND human_summary IS NOT NULL RETURNING human_summary`) and inject only when this turn won the claim. (Conflicts with A2's "clear after success"; needs deliberate design — hence REC.)

**A4 · [should-fix] [anticipated-failure] Escalation mirror to ManyChat is fire-and-forget with no retry/reconcile · [REC]**
- location: `agent.service.ts:378-384` (`void applyState(...).catch(...)`).
- scenario: `applyState` fails (ManyChat 429/5xx/timeout/`MANYCHAT_ENABLED=false`); DB says `human`, ManyChat field/tag still say `bot`.
- impact: split-brain between DB source-of-truth and ManyChat automations; no retry/outbox/reconcile. (Same root cause as R4/D4.)
- fix: persist a mirror-pending marker / enqueue a bounded retry; reconcile on next inbound. (Larger — see R4.)

### Nits

**A5 · [nit] [confirmed-bug] Stale startup banner `model=claude-sonnet-4-6, tools=10` · [REC]**
- location: `agent.service.ts:188-190` (hardcoded string; real model is decided in the Mastra factory, vision uses a separate `VISION_MODEL_ID`).
- impact: operational only — a misleading log during an incident.
- fix: derive the count/model from the wired values, or drop the specifics.

---

## 2. Conversation control & state — `conversation-control.service.ts`, `conversations.service.ts`

### Anticipated failures

**B1 · [should-fix] [anticipated-failure] State transitions are non-atomic read-then-write (`setAiState` is a blind overwrite) · [REC]**
- location: `conversations.service.ts:126-156` (escalateToHuman: find → setAiState → recordEvent, non-transactional); `conversation-control.service.ts` pause/resume/assign/handoff follow the same five-step pattern; `setAiState` writes a fixed patch with no precondition (`conversations.repository.ts:196-216`).
- scenario: a human takes over mid-turn (admin `assign` → `human`) while the bot is generating and then calls `escalate_to_human`; the two writers to the one control row interleave with last-writer-wins.
- impact: lost-update on `ai_state`/`assignedTo`/`handoffReason`; `conversation_events` history can show inconsistent from/to.
- fix: make transitions conditional (`UPDATE … WHERE id=? AND ai_state=<expectedFrom>`) or wrap load+update+event in a tx with `SELECT … FOR UPDATE`.

**B2 · [should-fix] [anticipated-failure] Reply gate reads `ai_state` once, before a multi-second `generate()` · [REC]**
- location: gate `agent.service.ts:263` reads `convo` captured at `:239`; `generate()` at `:357`.
- scenario: an admin pauses/hands off *during* the generate; the turn still delivers the bot reply.
- impact: a customer gets a stale bot reply after a human took over — the exact thing handoff prevents.
- fix: re-check `ai_state` immediately before delivering (re-load after generate; suppress send if `!== 'bot'`). Related to A1's gate.

### Nits

**B3 · [nit] [confirmed-bug] `escalateToHuman` records the event before verifying the row still exists, non-transactionally · [REC]**
- location: `conversations.service.ts:136-155` (setAiState may return undefined; recordEvent already ran; only then `if(!updated) throw`).
- impact: an orphan `conversation_events` row can be written for a transition that didn't happen.
- fix: check `updated` before `recordEvent`; wrap update + event in one transaction.

---

## 3. ManyChat adapter / Send API / async debounce worker

### Confirmed bugs

**R1 · [blocker] [confirmed-bug] Async path: a failed turn delivers NOTHING to the customer · [FIX NOW]**
- location: `manychat-webhook.controller.ts:126-138` (`processBatch` has no try/catch); the rejection only hits `debounce.service.ts:70-82`, which logs a warning.
- scenario: on `POST /webhook/manychat/async`, the agent runs out-of-band after the 202 ACK. If `handleMessage` throws (Claude 429/5xx, DB drop) or `sendReply` fails, there is no fallback send.
- impact: the customer on the recommended async (image/slow) path gets **total silence**; the inbound row was persisted so it *looks* answered in the admin panel. The sync handler has the never-5xx fallback; the async path has no equivalent.
- fix: wrap `processBatch`; on failure deliver `FALLBACK_ARABIC` via `sender.sendReply` (mirroring the sync catch at `:74-84`).

### Anticipated failures

**R2 · [should-fix] [confirmed-bug→anticipated] Send API `200` treated as proof of delivery; response body status ignored · [REC]**
- location: `manychat-sender.service.ts:60-63` (returns `true` on `res.ok`, never parses body); consumed as `delivered` at `conversation-control.service.ts:370-381`.
- scenario: ManyChat returns HTTP 200 with `{"status":"error",…}` (invalid subscriber, 24h-window/tag policy). `res.ok` is true → `sendReply` returns true.
- impact: a human-agent message is recorded `delivered:true` and shown as sent though ManyChat rejected it — silent partial failure on the manual-handoff path.
- fix: parse the body and require `status==='success'` before returning true. **REC, not auto-fixed:** the sender file itself states the ManyChat Send API response contract is *unconfirmed* ("MUST be confirmed against the ManyChat account before going live"); hard-coding a body shape now risks breaking delivery detection. Confirm the real response shape first.

**R3 · [should-fix] [confirmed-bug] Sync webhook can exceed ManyChat's ~10s timeout (Vision + Claude run inline) · [REC]**
- location: sync handler `manychat-webhook.controller.ts:63-73` → `agent.service.ts` runs `vision.extractAttributes` (`:304`, image download up to 8s) then `generate()` (`:357`, up to ~10 tool round-trips), all on the request thread.
- scenario: a customer sends a photo on the SYNC route.
- impact: ManyChat aborts at 10s; the socket is already closed so the never-5xx fallback never arrives; the customer sees nothing.
- fix: don't run the inline vision pre-step on the sync path (image turns belong on async), or bound the whole turn with an overall deadline returning `FALLBACK_ARABIC` well under 10s. **REC** — touches the sync/async routing contract.

**R4 · [should-fix] [anticipated-failure] No retry/backoff on any ManyChat call; one blip → permanent state divergence · [REC]**
- location: `manychat-control.service.ts:54-85` (`post`), `:182-217` (`getInfo`); `manychat-sender.service.ts:46-71`. All single-shot.
- scenario: ManyChat 429/503 during `applyState` mirroring (escalation, pause/resume/assign/handoff).
- impact: DB and ManyChat `ai_state` field/tag diverge with no reconciliation; ManyChat-side flows misroute.
- fix: bounded retry-with-backoff (honor `Retry-After`) in the shared `post()`/`sendReply`; and/or a periodic reconcile of recently-changed conversations. Larger — REC.

**R5 · [should-fix] [anticipated-failure] `applyState` mirror is partial-failure-prone (field-set ignored, tag/flow via `allSettled`) · [REC]**
- location: `manychat-control.service.ts:238-273` (step-1 `setCustomFieldByName` boolean ignored; step-2 ops via `Promise.allSettled`, `applyState` resolves `void`).
- scenario: the field write fails but tag/flow succeed (or vice versa).
- impact: ManyChat half-applied (tag present, `ai_state` field stale) and no caller can detect it.
- fix: inspect the step-1 boolean + `allSettled` results; log at error and (with R4) retry on partial application.

### Nits

**R6 · [nit] [anticipated-failure] Async reply persisted but not delivered (saved-but-not-sent) is invisible · [REC]**
- location: `manychat-webhook.controller.ts:130-137` (the `sendReply` boolean is discarded).
- fix: capture the boolean; on false, log + record a delivery-failure event (folds into R1).

---

## 4. Idempotency & concurrency — debounce, inbound dedup, COD draft

### Confirmed bugs / anticipated

**I1 · [should-fix] [confirmed-bug] Inbound dedup is SELECT-then-INSERT; the unique index doesn't stop a double `generate()` · [STOP]**
- location: `agent.service.ts:248-256` (SELECT) → `:346-361` (insert via best-effort `logTurn`, which *swallows* the conflict at `:403-414`) → `generate()` at `:357`. Backstop index `message.entity.ts:46-49` (partial UNIQUE on `(conversation_id, external_id) WHERE external_id IS NOT NULL`).
- scenario: two duplicate webhooks with the same `external_id` arrive together; both SELECTs return undefined; both pass the gate; both call `generate()`. The second row insert violates the index but `logTurn` ignores it.
- impact: the index blocks the duplicate *row* but NOT the duplicate LLM turn or the second reply — the customer can get two replies + double token cost for one message.
- fix (specified): insert the inbound row FIRST with `onConflictDoNothing({ target:[conversationId,externalId], targetWhere: sql\`external_id is not null\` }).returning()`; treat 0 rows as "already processed → return early" before `generate()`. **STOP (scope guard):** this restructures the hottest path and must match the *partial*-index predicate exactly in `onConflictDoNothing`; better as its own focused change with concurrency tests. Specified, not applied.

**I2 · [should-fix] [anticipated-failure] `findOrCreateByPsid` is SELECT-then-INSERT with no UNIQUE on `conversations.psid` · [REC + migration on go-ahead]**
- location: `conversations.service.ts:59-72`; `psid` index is non-unique (`conversation.entity.ts:49`); `findConversationByPsid` already orders by `created_at desc` (a tell that dupes are expected).
- scenario: two near-simultaneous first-ever messages from one contact both insert a conversation row.
- impact: split history/state/ai_state across two rows for one customer; fragments the dedup (the `(conversation_id, external_id)` index is per-conversation).
- fix: add a UNIQUE index on `conversations.psid` (migration `0013`) + `onConflictDoNothing` re-select in `findOrCreateByPsid`. **REC** — adding UNIQUE to existing data can fail if dupes exist; generate (not apply) the migration on go-ahead.

**I3 · [should-fix] [anticipated-failure] COD draft idempotency is SELECT-then-INSERT with no UNIQUE · [REC + migration on go-ahead]**
- location: `orders.service.ts` find-open-draft → `createWithItems`; only a non-unique `orders_conversation_id_idx`.
- scenario: `capture_order` runs twice (model retry or the I1 race); two `draft` orders are created.
- impact: duplicate COD drafts per cart; a human fulfills duplicates.
- fix: partial UNIQUE on `orders(conversation_id) WHERE status='draft'` (migration `0013`) + `onConflictDoNothing` re-select. **REC** — schema; generate on go-ahead.

### Nits

**I4 · [nit] [anticipated-failure] Debounce buffer is in-process only; horizontal scaling silently breaks coalescing · [REC]**
- location: `debounce.service.ts:11-14,33` (in-memory `Map`, documented single-instance).
- impact: with >1 replica, the same contact's messages aren't coalesced; multiple concurrent turns/replies.
- fix: shared lock/queue (Redis/BullMQ keyed by `contactId`) before multi-instance deploy, or enforce + document single-instance.

**I5 · [nit] [anticipated-failure] Debounce flush deletes the batch before async `generate()` completes · [REC]**
- location: `debounce.service.ts` fire path; driven by `manychat-webhook.controller.ts:103-138`.
- scenario: a new inbound for the same contact arrives while a prior slow turn is still generating; a second batch fires concurrently.
- impact: two turns in parallel for one customer (overlaps I1). 
- fix: per-key serialization (chain the next batch behind the previous `handleMessage` settle).

---

## 5. Vision & visual search

### Anticipated failures

**V1 · [blocker] [anticipated-failure] SSRF via customer-controlled image URL — server fetches arbitrary hosts/IPs · [FIX NOW]**
- location: `image-download.util.ts:87-102` (`fetch(url)` — no scheme/host validation), reached from the vision pre-step (`agent.service.ts:294-306`); the visual-search path `products.service.ts:384` (`findSimilarByImage` → `embedImage` → `RawImage.read`). URL = webhook `lastImageUrl`, only `z.string().url()`.
- scenario: a caller sets `lastImageUrl` to `http://169.254.169.254/…`, `http://localhost/…`, or an internal IP; the backend fetches it server-side.
- impact: SSRF — reach cloud metadata (credential theft), internal-only services, network mapping from the backend's position.
- fix: validate the URL before fetch — allow only `http(s)`, reject hostnames that are (or DNS-resolve to) private/loopback/link-local/unspecified ranges. Guard the two **customer** sinks (`downloadImage`, `findSimilarByImage`); never inside `embedImage` (shared with catalog indexing at `products.service.ts:783/857`).

**V2 · [should-fix] [anticipated-failure] Visual-search query vector built by raw string join — non-finite floats → invalid SQL · [REC]**
- location: `product-image-embeddings.repository.ts:156,162,173` (`[${embedding.join(',')}]::vector`).
- scenario: the embedding model returns `NaN`/`Infinity` (corrupt image edge case); `join` renders `NaN`/`Infinity`; pgvector rejects the literal and the ANN query throws.
- impact: the tool's try/catch swallows it to "no matches" — a broken pipeline shown to the customer as empty results. (Publish filter itself is correct: `WHERE p.is_published = true` at `:171` — not a leak.)
- fix: validate the embedding is all-finite before building the literal (or bind as a typed param); distinguish pipeline-error from no-match.

### Nits

**V3 · [nit] [anticipated-failure] `embedImage` does an unbounded URL fetch (no timeout) on the visual-search path · [REC]**
- location: `embedding.service.ts:88-91` (`RawImage.read(url)` — no `AbortSignal`).
- impact: a slow CDN can stall the turn (compounds R3 on the sync path).
- fix: download via the timed `downloadImage` util (then decode from buffer) or pass an abort signal. (Refactor of the embed path — REC.)

---

## 6. Data layer / schema / migrations

### Confirmed bugs

**D1 · [should-fix] [confirmed-bug] `0012` backfill targets a JSONB shape no writer produces · [REC]**
- location: `drizzle/0012_lively_blizzard.sql:25` — `UPDATE conversations SET ai_state='human' WHERE state->>'stage' = 'needs_human'`. No code in `src/` ever writes `state.stage='needs_human'` (the only escalation writer sets the dedicated `ai_state` column and leaves `state` unchanged — `conversations.service.ts:119-121`).
- scenario: conversations that were "with a human" before 0012 are not matched.
- impact: such rows stay `ai_state='bot'` (column default); on the next inbound the bot replies over a live human handoff. The backfill is effectively a no-op against the real data shape.
- fix: **REC** — there is no durable pre-0012 marker to backfill from (prior state lived in Mastra working memory, not `state.stage`), so no correct data-only fix exists. Recommend removing the misleading `WHERE` (or backfilling from `conversation_events` if/when present) and documenting that pre-0012 handoffs can't be reconstructed. Not auto-rewriting an applied migration.

### Anticipated failures

**D2 · [should-fix] [anticipated-failure] DB `ai_state` and ManyChat custom field drift on a failed mirror (no reconciliation) · [REC]** — same root cause as A4/R4/R5; consolidated there.

### Nits

**D3 · [nit] [anticipated-failure] `orders.status` / `orders.source` / `conversation_events.type` enforced only in zod, not the DB · [REC]**
- location: enums in drizzle-zod only; no DB `CHECK` (only `conversations.ai_state` got one, `0012:23`).
- fix: add `CHECK` constraints mirroring the `ai_state` pattern (migration `0013`) so the DB is the final contract.

**D4 · [nit] [anticipated-failure] Derived sizes `'1'`/`'2'` are silently rejected unless `products.sizes` stores those exact tokens · [REC]**
- location: capture validates `size ∈ product.sizes` (`orders.service.ts:313-328`); size vocab is `'1'`/`'2'` from `size_chart` (`0010`); `products.sizes` is free-form `text[]` with nothing tying it to the chart.
- impact: orders for correctly-sized items blocked by a vocabulary mismatch, surfaced as "size not available".
- fix: constrain/validate `products.sizes` against the chart tokens at the admin write path, or map at capture. (Matches the known `masa-abaya-size-codes` constraint.)

**D5 · [nit] [anticipated-failure] No `ON DELETE` cascade review surfaced issues — verified clean.** `orders.conversation_id` → `set null` (order kept, link nulled, `buildResultFromPersisted` null-coalesces); `order_items` → `cascade`; capture persists header+items in one transaction. No finding.

---

## 7. Security / auth / input

### Confirmed bugs

**S1 · [blocker] [confirmed-bug] Unauthenticated `POST /agent/message` bypasses the webhook secret guard · [FIX NOW]**
- location: `agent.controller.ts:26-55` — NO `@UseGuards`; registered unconditionally in `agent.module.ts:42`.
- scenario: anyone who can reach the host POSTs `{contactId,text,…}` to `/agent/message` with no shared-secret check.
- impact: anonymous access to the full agent pipeline — invoke Claude (cost/abuse), trigger write tools (`capture_order`, `escalate_to_human`), poison any contact's history (attacker-chosen `contactId`), and drive the server-side image fetch (S/V1). The `ManyChatSecretGuard` on `/webhook/manychat` is fully sidestepped.
- fix: add `@UseGuards(ManyChatSecretGuard)` to `AgentController` (matches the webhook; dev with no secret still allowed, prod fails closed). Minimal and reuses the existing guard.

**S2 · [should-fix→blocker] [confirmed-bug] Open admin self-registration mints an admin account · [REC — product decision]**
- location: `auth.controller.ts:41-57` (`POST /auth/register`, no guard, "Open self-registration"); `auth.service.ts:35-47` issues a JWT; `normalizeRole` collapses unknown roles to `admin` (`:82-85`).
- scenario: an unauthenticated client registers and receives a valid admin JWT, passing `RolesGuard` on every `/admin/*` route.
- impact: complete auth bypass of the entire admin surface (products, orders, knowledge, conversation-control). High impact.
- fix: gate `/auth/register` behind `JwtAuthGuard + RolesGuard('admin')`, or disable in production and seed the first admin out-of-band. **REC, not auto-fixed:** open registration is an explicit, deliberate design choice and locking it changes the admin-panel onboarding flow (how is the first admin created?). This is a product decision — flagged for your go-ahead with a recommended default of "admin-gated in production."

### Anticipated failures

**S3 · [should-fix] [anticipated-failure] Unbounded webhook payload: no field length caps · [FIX NOW (caps) + REC (bodyLimit)]**
- location: `manychat-webhook.dto.ts:30-59` (`text: z.string().min(1)` — no `.max`; url/adRef/name/contactId/messageId uncapped); `main.ts:22-25` constructs `FastifyAdapter` with no explicit `bodyLimit`; the webhook schema is not `.strict()`.
- scenario: a caller POSTs a near-1MB `text`; it passes validation, is fed to `generate()` and persisted, amplifying LLM cost + memory on every turn (reachable anonymously via S1).
- impact: resource/cost DoS amplification; oversized strings stored and re-sent to the model.
- fix: add `.max(...)` caps to the DTO fields **[FIX NOW]** (precise, safe). An explicit app-wide `bodyLimit` on the FastifyAdapter is **[REC]** — choosing a value safe for admin JSON payloads needs their size profile.

**S4 · [should-fix] [anticipated-failure] Prompt-injection can drive `escalate_to_human`; customer FB `name` injected as a `system` message · [REC]**
- location: `escalate-to-human.tool.ts:18-51` (`reason` is free LLM text); `agent.service.ts:317-325` (customer `name` injected verbatim as `role:'system'`), `:357-361` (customer `text` is the prompt), mirrored to ManyChat at `:378-384`.
- scenario: a crafted message/display-name steers the model to escalate with attacker-authored reasons or spam handoffs.
- impact: customer-triggered state flips + operational noise. **Bounded:** the sensitive boundary (identity/source for `capture_order`) is correctly read from `requestContext`, never tool input (`capture-order.tool.ts:96-109`), and `get_order_status` scopes foreign orders to empty — so data-exfiltration/privilege-escalation via tools is NOT achievable. Residual risk is state-flip + spam.
- fix: don't elevate the customer `name` to a `system` message (pass it as untrusted data / persist to working memory out-of-band); add a per-conversation escalation rate-guard; treat `reason` as display-only untrusted text in the admin UI.

### Nits

**S5 · [nit] [confirmed-bug] Unbounded free-text on authenticated control inputs (`reason`/`summary`/human `text`) · [REC]**
- location: `dto/conversation-control.dto.ts:33,42,66` (`.min(1)`, no `.max`); `humanSummary` later injected as a `system` message (`agent.service.ts:329-333`).
- impact: low (behind admin auth) — defense-in-depth gap; a large `humanSummary` becomes attacker-influenced system content.
- fix: add `.max(...)` caps mirroring `durationMinutes`. (Could fold into S3's commit on go-ahead.)

**S6 · [nit] [anticipated-failure] 5xx error envelope can echo internal `HttpException` detail · [REC]**
- location: `all-exceptions.filter.ts:29-46` (forwards `getResponse()` verbatim for `HttpException`).
- impact: information disclosure of internal error detail. **No secret exposure confirmed** (no secret is interpolated into any thrown message/log/response).
- fix: whitelist the returned fields (statusCode + safe message); never forward raw `getResponse()` for 5xx.

---

## Verified-clean (no finding) — checked and correct

- **Publish gate on ALL read paths:** attribute `search`/`searchFuzzy`/`list` via `toPublishedFilter`; ad fast-path `findByAdRef` (`is_published=true` in SQL); visual search `searchSimilarByEmbedding` (`WHERE p.is_published = true`); `getMedia`/`checkAvailability`/`resolveForOrder` via `findPublishedRaw`; order capture re-validates via `checkAvailability`; knowledge forces `isPublished:true`. **No draft-leak path found.**
- **Thin-adapter tools:** size→`SizingService`, money/delivery/totals→`OrdersService`, image-over-ad routing code-enforced, overflow cap in `AgentService`. No business logic delegated to the LLM.
- **Closed-enum vision:** color/size are `z.enum` sourced from the catalog.
- **Reply gate** ingests-and-stays-silent off-bot; **escalation line** emitted once by the tool.
- **Webhook secret guard:** `timingSafeEqual` with length short-circuit, fail-closed in production, rejects missing/array headers.
- **All `/admin/*` controllers** carry `JwtAuthGuard + RolesGuard + @Roles`; **write tools** read identity from `requestContext`, never tool input; `get_order_status` scopes foreign orders to empty. **No secret in any log line or HTTP response.**
- **Idempotency index** is correct: UNIQUE, composite `(conversation_id, external_id)`, partial `WHERE external_id IS NOT NULL`, faithfully recorded in the meta snapshot (no schema/snapshot drift). `_journal` is sequential `0000–0012`.

---

## Fix plan

### Applied now (this pass) — confirmed blocker/should-fix bugs + safe anticipated-blocker
| ID | Fix | Type |
|---|---|---|
| A1 | Honor `pausedUntil` → timed pauses auto-resume on the inbound path | confirmed-bug blocker |
| A2 | Inject one-shot `humanSummary` only after a successful `generate()` | confirmed-bug should-fix |
| R1 | Async path delivers `FALLBACK_ARABIC` when the turn fails | confirmed-bug blocker |
| S1 | `@UseGuards(ManyChatSecretGuard)` on the temp `/agent/message` surface | confirmed-bug blocker |
| V1 | SSRF guard on the two customer image sinks (`downloadImage`, `findSimilarByImage`) | anticipated-failure blocker (safe) |
| S3 | `.max(...)` length caps on the webhook DTO fields | anticipated-failure should-fix (safe) |

Each lands as its own commit with a regression test; suite + build kept green.

> **Working-tree note (H):** the branch carried an in-progress change to
> `conversations.repository.ts` that qualifies the correlated-subquery column via
> `sql.identifier`, with a comment claiming the bare `${conversations.id}` embed
> renders unqualified and makes the preview always-null. **Verified false for
> drizzle-orm 0.45.2:** compiling the query both ways yields byte-identical SQL
> (`WHERE m.conversation_id = "conversations"."id"` in both). The change is a
> functional no-op and its comment/memory note are inaccurate. Left **uncommitted**
> pending your decision: revert it, or keep it as an explicit-style change with a
> corrected comment. Not committed as a "fix."

### Awaiting your go-ahead (recommendations / scope-guard stops)
- **I1 [STOP]** insert-first inbound dedup (restructures the hot path; must match the partial-index predicate) — fix specified above.
- **S2 [REC]** lock down open admin self-registration (product/onboarding decision).
- **R2 [REC]** Send-API delivery check (needs the confirmed ManyChat response contract).
- **R3 [REC]** sync-path 10s deadline / no inline vision on sync.
- **R4 / R5 / A4 / D2 [REC]** ManyChat retry-with-backoff + state reconciliation; surface partial `applyState`.
- **I2 / I3 [REC + migration on go-ahead]** UNIQUE on `conversations.psid` and partial UNIQUE on `orders(conversation_id) WHERE status='draft'` (generate migration `0013`, do not apply).
- **B1 / B2 / B3 [REC]** atomic/conditional conversation-state transitions; re-check `ai_state` before delivery.
- **A3 [REC]** atomic claim for `humanSummary`.
- **D1 [REC]** correct/remove the `0012` no-op backfill.
- **D3 [REC]** DB `CHECK` constraints for order status/source + event type.
- **D4 [REC]** tie `products.sizes` to the `size_chart` tokens.
- **V2 / V3 [REC]** finite-vector guard; bounded `embedImage` fetch.
- **S5 / S6 [REC]** cap control-input free-text; sanitize the 5xx error envelope.
- **A5 / I4 / I5 [REC]** stale startup log; horizontal-scaling debounce; per-key flush serialization.

**No migration applied. No `git push`.** Schema items (I2/I3/D3) will have migration `0013` generated only, on go-ahead.
