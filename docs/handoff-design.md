# Conversation Control & Human Handoff — Design (AIA-34)

> WS0 deliverable. This is the audit of the **existing** code and the reconciliation of the
> "ManyChat-native hybrid" handoff design to it. Where the orchestration prompt's names/shapes
> conflict with the real code, the real code wins — documented below. Everything in the
> implementation follows this document.

## 1. Conversation / message model (as it exists today)

- **`conversations`** (`src/modules/conversations/entities/conversation.entity.ts`): `id` (uuid),
  `psid` (text, **stores the ManyChat `contact_id`**, not a real Facebook PSID — ManyChat never
  exposes the PSID), `threadId` (text, `thread:{contactId}`), `adRef`, `state` (jsonb, free-form
  preferences + funnel stage), `createdAt`. Index `conversations_psid_idx`. **No dedicated
  state/assignment columns** today — handoff is tracked inside the `state` jsonb.
- **`messages`** (`message.entity.ts`): `id`, `conversationId` (FK cascade), `role` (text, zod enum
  `['customer','agent']` — **no `human` role yet**), `content`, `imageUrl`, `attributes` (jsonb,
  vision + eval), `externalId` (idempotency key), `createdAt`. Unique partial index
  `messages_conversation_external_id_uq` on `(conversation_id, external_id)`.
- **Identity / keying**: `resourceId = contactId` and `threadId = thread:{contactId}` are derived in
  `AgentService.handleMessage` (`agent.service.ts:234-235`). The same `contactId` keys Mastra working
  memory (`scope:'resource'`, `mastra.factory.ts`) **and** the ManyChat Send API (`subscriber_id`).
  `conversations.psid` is therefore the join key between our DB, Mastra memory, and ManyChat.

**Reconciliation (WS1):** we add **dedicated, queryable columns** to `conversations`
(`ai_state` default `bot`, `assigned_to`, `handoff_reason`, `human_summary`, `paused_until`,
`ai_state_updated_at`) rather than overloading `state` jsonb, because the list/filter APIs
(`?state=human`, `?assignedTo=`) need indexed predicates and a CHECK constraint. `state` jsonb stays
for funnel/preferences. `messages.role` gains `'human'` (column is `text`; only the zod enum changes —
no DDL). A `conversation_events` audit table records every transition.

## 2. Reply pipeline & the secondary-gate point

- Two transports, both funnel through `AgentService.handleMessage`:
  - **Sync** — `POST /webhook/manychat` returns the Dynamic Block inline (HTTP 200).
  - **Async** — `POST /webhook/manychat/async` → `DebounceService` buffer → `mergeTurns` → `handleMessage`
    → `ManyChatSenderService.sendReply` (Send API). Sync vs async is chosen by **which URL** ManyChat calls.
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
query). It still logs the inbound, still skips `generate()`. **Return value** is `{ reply: '' }`
(silent): the sync controller maps `''` → the verified empty Dynamic Block (`messages:[]`); the async
`sendReply('')` no-ops. Atomicity: `aiState` is read once at the top of the turn; a mid-turn admin
flip is benign because the inbound is idempotent (`externalId`) and the gate either logs-and-returns
or proceeds, never both — no transaction needed.

## 3. `escalate_to_human` today (to be wired)

- Tool `tools/escalate-to-human.tool.ts`: reads `conversationId` from `ctx.requestContext` (security
  boundary), calls `conversations.escalateToHuman(conversationId, reason)`, returns
  `{ escalated:true, message: HANDOFF_REPLY }`.
- Service `conversations.service.ts:122-140`: `mergeConversationState(id, { stage:'needs_human',
  escalation:{reason, at} })` — atomic jsonb shallow-merge. **Touches ManyChat: not at all today.**

**Reconciliation (WS4):** `escalateToHuman` switches to writing the **`ai_state` column** (`= 'human'`
+ `handoff_reason`) via a new `repo.setAiState`, and records a `conversation_events` row. The
**ManyChat mirror** (set the `ai_state` field, optional pause flow + human tag) is performed in
**`AgentService` after `generate()`** by inspecting `result.toolResults` for `escalate_to_human` —
NOT inside the tool/service. Reason: the tool only receives `ConversationsService`
(`tools/index.ts:56`), and `ConversationsService → ManyChatControlService` would invert the existing
`AgentModule → ConversationsModule` import and create a cycle. `AgentService` already has `contactId`
(`resourceId`) in scope and already introspects `toolResults`. The mirror is fire-and-forget (DB is
source of truth; ManyChat sync is best-effort, logged on failure).

## 4. `ManyChatSenderService` (reuse) and where `ManyChatControlService` goes

- `manychat-sender.service.ts`: `sendReply(contactId, block): Promise<boolean>` → `POST
  {MANYCHAT_SEND_URL}` (`/fb/sending/sendContent`), `Authorization: Bearer ${MANYCHAT_API_TOKEN}`,
  body `{ subscriber_id, data: block, message_tag:'ACCOUNT_UPDATE' }`, 8s timeout, **never throws**
  (returns false on disabled/no-token/failure). Gated by `MANYCHAT_ENABLED`.
- Dynamic Block builder `manychat.formatter.ts`: `toDynamicBlock({reply, products?, overflowCount?})`
  → `{ version:'v2', content:{ messages, actions:[], quick_replies:[] } }`; empty reply → `messages:[]`.
- **No ManyChat Public API client exists** (no `setCustomFieldByName`/`sendFlow`/`getInfo`/`addTagByName`
  anywhere). All greenfield.

**Reconciliation (WS2):** new **`ManyChatControlService`** in `src/modules/agent/manychat/`, modeled
exactly on `ManyChatSenderService` (ConfigService token, `fetch`, 8s timeout, best-effort never-throw,
`MANYCHAT_ENABLED` kill-switch). Methods: `setCustomFieldByName`, `setCustomFields`, `addTagByName`,
`removeTagByName`, `sendFlow`, `getInfo`, plus a convenience `applyState(subId, bot|human|paused)`.
**Token: reuse `MANYCHAT_API_TOKEN`** — one ManyChat account key authorizes both the Send API and the
Public API under `api.manychat.com`. Registered in `AgentModule` providers + exports. Human messaging
reuses `ManyChatSenderService.sendReply` + `toDynamicBlock`.

## 5. ManyChat-side changes required (full guide in `docs/manychat-handoff-setup.md`)

- **Custom fields**: `ai_state` (bot|human|paused), `ai_handoff_reason`, `ai_human_summary`.
- **Entry gate**: a Condition before the External Request so the webhook only fires when
  `ai_state == bot` (paused/human conversations never reach our backend — the efficiency win).
- **Handoff path**: a Condition on the AI's handoff signal → **Pause all automations** + Assign/Open
  conversation (no flow steps may follow Pause; Assign in the same node is allowed).
- **Resume**: a small flow callable from the backend via `sendFlow` that resumes automation / resets
  `ai_state = bot`.
- **Shared secret**: the inbound `x-manychat-secret` header (`WEBHOOK_SHARED_SECRET`,
  `ManyChatSecretGuard`) stays as-is.

### ManyChat Public API constraints driving the design
- **No direct pause/resume-automation API** — "Pause all automations" is a flow/Inbox action
  (30 min → indefinite, auto-resume on expiry). Backend pauses by `sendFlow` (a flow containing Pause)
  and/or by the `ai_state==bot` entry gate; backend resumes by flipping `ai_state` back to `bot`
  (+ optional resume flow). **Backend auto-resume scheduler is deferred to v1.1** — we store
  `paused_until` but do not enforce it with a cron; resume is manual or via ManyChat's native expiry.
- `sendFlow` does **not** set custom fields → call `setCustomField(s)` **before** `sendFlow`.
- Native pause does **not** fire when a human replies from the raw FB/IG app → we standardize on **one**
  human-reply surface: **our admin panel** (`POST /admin/conversations/:id/messages`).
- ManyChat does **not** replay the human↔customer conversation to us → on resume we inject the human's
  wrap-up (`human_summary`) into the agent's next turn (WS7).

## 6. Decisions (confirmed with the product owner)

1. Escalate/handoff with no human online → `ai_state = 'human'` (queued; AI silent until resumed).
2. Backend auto-resume scheduler → **deferred to v1.1**; `paused_until` stored only.
3. Paused/human turns → **handoff line once** (delivered on the escalation turn by the tool), **silent
   thereafter** (gate returns `''`).
4. Reuse `MANYCHAT_API_TOKEN` for the Public API.

## 7. Deviations from the orchestration prompt (real code wins)

1. The "secondary gate" is a **generalization of an existing gate**, not a new check.
2. ManyChat escalation sync sits in **`AgentService` post-generate**, not the tool/service (module-cycle
   avoidance).
3. `ConversationControlService` + the admin controller live in **`AgentModule`** (it already imports
   `ConversationsModule` and provides the ManyChat services) — cycle-safe.
4. **Reuse `MANYCHAT_API_TOKEN`** (single account key); only base/field/flow/tag env vars are added.
5. Paused turns are **silent** (`''`), a deliberate change from today's "HANDOFF_REPLY every turn".
6. Migration `0012` is **generate-only**, auto-named, with a backfill `UPDATE conversations SET
   ai_state='human' WHERE state->>'stage'='needs_human'`. `messages.role='human'` produces no DDL.
7. Setup guide filename `docs/manychat-handoff-setup.md` (cross-links the existing
   `docs/manychat-setup.md`).
8. Deferred (scope): backend auto-resume scheduler, true `unreadCount`/last-read tracking, SSE stream.

## 8. Branch base

`dev` is far behind and lacks the entire ManyChat foundation this work depends on (the gate, the
sender/secret/formatter services, migrations 0009–0011). Per the product owner, `feature/AIA-34-
conversation-control` is **stacked on `feature/AIA-32-manychat-hardening`** (not branched off `dev`);
AIA-34 integrates after/with AIA-32. This is the only base on which the plan builds (gate
generalization, migration 0012, sender/formatter reuse).
