# Conversation Control & Human Handoff — Design (AIA-34)

> WS0 deliverable. This is the audit of the **existing** code and the handoff design reconciled to
> it. Where the orchestration prompt's names/shapes conflict with the real code, the real code wins
> — documented below. Everything in the implementation follows this document.
>
> **Transport note:** the Facebook transport is **Meta's Messenger Platform (Graph API)** directly
> (see `docs/messenger-setup.md`). The DB column `ai_state` (`bot` | `human` | `paused`) is the
> **single source of truth** — there is no external custom-field/flow store to keep in sync; the
> reply gate lives entirely in the backend.

## 1. Conversation / message model (as it exists today)

- **`conversations`** (`src/modules/conversations/entities/conversation.entity.ts`): `id` (uuid),
  `psid` (text, **stores the Facebook PSID** — `event.sender.id` from the Messenger webhook),
  `threadId` (text, `thread:{psid}`), `adRef`, `state` (jsonb, free-form
  preferences + funnel stage), `createdAt`. Index `conversations_psid_idx`. **No dedicated
  state/assignment columns** today — handoff is tracked inside the `state` jsonb.
- **`messages`** (`message.entity.ts`): `id`, `conversationId` (FK cascade), `role` (text, zod enum
  `['customer','agent']` — **no `human` role yet**), `content`, `imageUrl`, `attributes` (jsonb,
  vision + eval), `externalId` (idempotency key), `createdAt`. Unique partial index
  `messages_conversation_external_id_uq` on `(conversation_id, external_id)`.
- **Identity / keying**: `resourceId = psid` and `threadId = thread:{psid}` are derived in
  `AgentService.handleMessage` (`agent.service.ts:234-235`). The same PSID keys Mastra working
  memory (`scope:'resource'`, `mastra.factory.ts`) **and** the Graph Send API recipient
  (`recipient.id`). `conversations.psid` is therefore the join key between our DB, Mastra memory,
  and the Messenger transport.

**Reconciliation (WS1):** we add **dedicated, queryable columns** to `conversations`
(`ai_state` default `bot`, `assigned_to`, `handoff_reason`, `human_summary`, `paused_until`,
`ai_state_updated_at`) rather than overloading `state` jsonb, because the list/filter APIs
(`?state=human`, `?assignedTo=`) need indexed predicates and a CHECK constraint. `state` jsonb stays
for funnel/preferences. `messages.role` gains `'human'` (column is `text`; only the zod enum changes —
no DDL). A `conversation_events` audit table records every transition.

## 2. Reply pipeline & the secondary-gate point

- One inbound transport, funneling through `AgentService.handleMessage`:
  - **`POST /webhook/messenger`** (signed, `X-Hub-Signature-256`) ACKs 200 immediately, then
    `DebounceService` buffer → `mergeTurns` → `handleMessage` → `MessengerClient.sendText` /
    `sendTemplate` (Graph Send API) **off the request thread**. The agent's work never blocks the
    webhook ACK.
- **A bot-pause gate already exists** at `agent.service.ts:256-269`:
  ```ts
  const state = convo.state as { stage?: string } | null;
  if (state?.stage === 'needs_human') {
    await this.logTurn({ conversationId: convo.id, role: 'customer', content: input.text,
                         externalId: dedupKey, ...(imageUrl?) });
    return { reply: HANDOFF_REPLY };
  }
  ```
  It logs the inbound and returns **before** `requestContext` is built and **before**
  `salesAgent.generate()` (line 340). This is exactly the single point the "secondary gate" needs.

**Reconciliation (WS3):** the secondary gate is a **generalization** of this existing check to
`convo.aiState !== 'bot'` (reading the new column on the row already fetched at line 237 — no extra
query). It still logs the inbound, still skips `generate()`. **Return value** signals "did not run"
(silent): the Messenger controller sees `reply.ran === false` and **sends nothing** — the inbound is
already persisted, so the gate is the single source of truth and no outbound Send API call is made.
Atomicity: `aiState` is read once at the top of the turn; a mid-turn admin flip is benign because the
inbound is idempotent (`externalId`) and the gate either logs-and-returns or proceeds, never both —
no transaction needed.

## 3. `escalate_to_human` today (to be wired)

- Tool `tools/escalate-to-human.tool.ts`: reads `conversationId` from `ctx.requestContext` (security
  boundary), calls `conversations.escalateToHuman(conversationId, reason)`, returns
  `{ escalated:true, message: HANDOFF_REPLY }`.
- Service `conversations.service.ts:122-140`: `mergeConversationState(id, { stage:'needs_human',
  escalation:{reason, at} })` — atomic jsonb shallow-merge.

**Reconciliation (WS4):** `escalateToHuman` switches to writing the **`ai_state` column** (`= 'human'`
+ `handoff_reason`) via a new `repo.setAiState`, and records a `conversation_events` row. Because the
Messenger transport has **no external state store** (no custom fields, tags, or flows to mirror), the
DB column is the sole source of truth — there is no out-of-band mirror to keep in sync, which removes
the entire class of "DB vs external field drift" failures. On the next inbound, the reply gate (§2)
reads `ai_state` and stays silent while a human handles the thread.

## 4. Outbound delivery (`MessengerClient`) and the reply gate

- `messenger.client.ts`: `sendText(psid, text, humanAgent?)`, `sendTemplate(psid, elements)`,
  `senderAction(psid, action)` → `POST https://graph.facebook.com/{version}/{PAGE_ID}/messages`,
  `Authorization: Bearer ${MESSENGER_PAGE_ACCESS_TOKEN}`, 8s timeout. In-window replies use
  `messaging_type:"RESPONSE"` (no tag); the human-agent path uses `messaging_type:"MESSAGE_TAG"` +
  `tag:"HUMAN_AGENT"`. Throws `MessengerSendError` on non-2xx so callers can swallow; skips silently
  (warn log) when the page id/token are absent.
- Carousel builder `messenger.formatter.ts`: `formatMessengerReply({reply, products?, overflowCount?})`
  → generic-template `elements` (≤8 cards) + optional overflow text.
- **No external control plane exists or is needed.** Unlike a middleware integration, there are no
  custom fields/tags/flows to set — pausing and resuming are enforced entirely by the in-backend
  reply gate reading the `ai_state` column.

**Where handoff lives:** the gate (§2) and `escalate_to_human` (§3) operate purely on the DB. Human
replies are delivered to the customer through the same `MessengerClient.sendText` (with the
`HUMAN_AGENT` tag when out of the 24-hour window). Registered in `AgentModule` providers + exports.

## 5. Transport-side changes required — none (backend-enforced handoff)

The Meta Messenger Platform is a thin transport: there is **no external automation engine** to gate,
no custom fields/tags/flows to create, and no middleware "pause automations" action. The entire
handoff lives in the backend:

- **State**: the `ai_state` column (`bot` | `human` | `paused`) on `conversations`, plus
  `handoff_reason` and `human_summary`. The DB is the single source of truth.
- **Gate**: the in-backend reply gate (§2) reads `ai_state` at the top of each turn and stays silent
  (sends nothing) when it is not `bot` — paused/human conversations get no bot reply.
- **Handoff path**: `escalate_to_human` (or admin `POST /admin/conversations/:id/handoff`) sets
  `ai_state = human` and records a `conversation_events` row. No external mirror.
- **Human replies**: delivered to the customer via `MessengerClient.sendText` (with the `HUMAN_AGENT`
  tag when outside Meta's 24-hour window).
- **Inbound auth**: the `X-Hub-Signature-256` HMAC check (`MessengerSignatureGuard`,
  `MESSENGER_APP_SECRET`) — see `docs/messenger-setup.md`.

### Constraints driving the design
- **Pause/resume is purely a DB flip** — there is no external automation to pause. Backend pauses by
  setting `ai_state = paused` (the gate then stays silent); backend resumes by flipping it back to
  `bot`. **Backend auto-resume scheduler is deferred to v1.1** — we store `paused_until` but do not
  enforce it with a cron; resume is manual via `POST /admin/conversations/:id/resume`.
- **One human-reply surface: our admin panel** (`POST /admin/conversations/:id/messages`). Replying
  to the customer from the raw Facebook app bypasses our state/audit, so all human replies go through
  the panel, which records the `role: human` row and delivers via the Send API.
- **The transport does not replay the human↔customer conversation to us** → on resume we inject the
  human's wrap-up (`human_summary`) into the agent's next turn (WS7).

## 6. Decisions (confirmed with the product owner)

1. Escalate/handoff with no human online → `ai_state = 'human'` (queued; AI silent until resumed).
2. Backend auto-resume scheduler → **deferred to v1.1**; `paused_until` stored only.
3. Paused/human turns → **handoff line once** (delivered on the escalation turn by the tool), **silent
   thereafter** (gate sends nothing).
4. DB `ai_state` is the sole source of truth — no external state store to reconcile.

## 7. Deviations from the orchestration prompt (real code wins)

1. The "secondary gate" is a **generalization of an existing gate**, not a new check.
2. Escalation state is written by the tool/service to the DB; the Messenger transport has no external
   mirror, so there is no post-generate sync step or module cycle to avoid.
3. `ConversationControlService` + the admin controller live in **`AgentModule`** (it already imports
   `ConversationsModule` and provides the Messenger services) — cycle-safe.
4. **DB-only state** (single source of truth); no external account token or field/flow env vars.
5. Paused turns are **silent**, a deliberate change from the older "HANDOFF_REPLY every turn".
6. Migration `0012` is **generate-only**, auto-named, with a backfill `UPDATE conversations SET
   ai_state='human' WHERE state->>'stage'='needs_human'`. `messages.role='human'` produces no DDL.
7. Operator wiring guide for the transport: `docs/messenger-setup.md`.
8. Deferred (scope): backend auto-resume scheduler, true `unreadCount`/last-read tracking, SSE stream.

## 8. Branch base

This work depends on the conversation foundation (the gate, the Messenger client/signature-guard/
formatter services, migrations 0009–0011) and the Meta Messenger transport migration. `feature/AIA-34-
conversation-control` is stacked on that foundation rather than branched off a stale `dev`. This is the
only base on which the plan builds (gate generalization, migration 0012, client/formatter reuse).
