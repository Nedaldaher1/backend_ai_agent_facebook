# ManyChat Conversation-Control & Human-Handoff Setup (AIA-34)

This guide wires the **conversation control & human handoff** feature into your
ManyChat bot. It builds on `manychat-setup.md` (the base webhook wiring — steps
1–6 there must already be done). Complete every step before relying on handoff in
production.

> **Architecture in one line:** a ManyChat custom field **`ai_state`**
> (`bot` | `human` | `paused`) is the shared source of truth. ManyChat only calls
> our webhook when `ai_state == bot`; our backend mirrors the field in its DB and
> drives it back through the ManyChat **Public API**. See `docs/handoff-design.md`.

---

## 1. Apply the database migration

The feature adds the `ai_state` mirror columns and the `conversation_events`
audit table (migration **`0012`**). Apply it before the control APIs will work:

```bash
bunx drizzle-kit migrate
```

(The migration is generated and reviewed; it also backfills `ai_state='human'`
for any thread previously escalated via the old `state.stage='needs_human'`.)

---

## 2. Create the custom fields

In ManyChat → **Settings → Fields → New Custom Field**, create three **text**
fields on the **Contact**:

| Field name | Type | Purpose |
|---|---|---|
| `ai_state` | Text | `bot` \| `human` \| `paused` — who is handling the conversation. The shared source of truth. |
| `ai_handoff_reason` | Text | Optional. The reason captured when the AI/admin escalated. |
| `ai_human_summary` | Text | Optional. The human's wrap-up, fed back to the AI on resume. |

If you rename `ai_state`, set `MANYCHAT_AI_STATE_FIELD` in `.env` to match (see §7).

**Initialise existing/new contacts to `bot`.** Add a "Set Custom Field
`ai_state = bot`" action at the very start of your main flow (or use ManyChat's
default-value feature) so a contact with an empty `ai_state` is treated as
bot-handled. Our backend treats only the literal `bot` as "AI active"; any other
value (including empty) makes the secondary gate stay silent.

---

## 3. Gate the External Request on `ai_state == bot` (the efficiency win)

Wrap the **External Request** node (from `manychat-setup.md` step 3) in a
**Condition** so paused / human-handled conversations never reach our backend:

```
Condition: ai_state  is  bot
   ├─ TRUE  → External Request → (render reply)      ← the existing AI path
   └─ FALSE → (do nothing / end)                     ← AI is paused or human-handled
```

When `ai_state != bot`, ManyChat skips the request entirely: no debounce, no LLM
call, no Send-API call. This is the primary gate. Our backend's code gate (the
"secondary gate") is the safety net for races and for control originating in our
admin panel.

---

## 4. Handoff path (AI → human)

When the agent calls `escalate_to_human` (or an admin hits `POST
/admin/conversations/:id/handoff`), our backend sets `ai_state = human` **and**
mirrors it to ManyChat via the Public API: it sets the `ai_state` field, adds the
**`ai_human`** tag, and (if configured) triggers the pause flow (§6).

To make ManyChat itself stop automating and route the thread to a human, add a
flow/condition that reacts to the handoff signal. Because **no flow steps may
follow a "Pause automations" action**, keep Pause and Assign in the **same node**:

```
Trigger: Tag "ai_human" added   (or Condition: ai_state is human)
   └─ Node:
        • Pause all automations  (duration: see §5)
        • Assign conversation  /  Open conversation in Live Chat
```

- **Tag-based trigger** (recommended): our backend adds the `ai_human` tag on
  handoff; a "Tag added" automation runs Pause + Assign.
- **Field-based**: a Condition on `ai_state is human` reached from the main flow.

---

## 5. There is no "pause/resume automation" API — what that means

ManyChat exposes **no** direct endpoint to pause or resume automation. "Pause all
automations" is a **flow/Inbox action** with a duration of **30 minutes →
indefinite** and **auto-resume when the duration expires**. Consequences baked
into this design:

- **Pausing from our backend** is done by (a) the `ai_state == bot` entry gate in
  §3, and/or (b) triggering a flow that contains the Pause action (`sendFlow`).
- **Resuming from our backend** is done by flipping `ai_state` back to `bot`
  (which re-opens the §3 gate) and optionally triggering a resume flow.
- **Backend auto-resume is deferred (v1.1).** We store `paused_until` but do not
  run a scheduler. A pause ends when: an admin calls `POST
  /admin/conversations/:id/resume`, **or** ManyChat's native pause duration
  expires. Choose a **finite** native pause duration if you want automatic
  recovery; choose **indefinite** if a human must always resume explicitly.

---

## 6. Optional pause / resume flows

If you want the backend to actively push a native pause/resume (beyond the field
gate), create two small flows and copy their IDs into `.env` (§7):

- **Pause flow** (`MANYCHAT_PAUSE_FLOW_ID`): a one-node flow containing **Pause
  all automations** (+ Assign). Our backend calls it via `sendFlow` on handoff /
  pause. *Note: `sendFlow` cannot set fields, so our backend always sets
  `ai_state` first, then triggers the flow.*
- **Resume flow** (`MANYCHAT_RESUME_FLOW_ID`): a flow that resumes automation /
  resets `ai_state = bot`. Called on resume.

Both are optional — if the IDs are unset, the backend simply sets the `ai_state`
field (and tag) and relies on the §3 gate. The `ai_human` tag name is
configurable via `MANYCHAT_HUMAN_TAG`.

---

## 7. Environment variables

Add to `.env` (the Public API reuses the same `MANYCHAT_API_TOKEN` as the Send
API — one ManyChat account key authorises both):

```dotenv
# Public API base (override only if ManyChat changes it)
MANYCHAT_API_BASE=https://api.manychat.com

# The custom-field name holding the handler state (must match §2)
MANYCHAT_AI_STATE_FIELD=ai_state

# Tag added/removed when a conversation goes to / leaves a human
MANYCHAT_HUMAN_TAG=ai_human

# Optional flow ids (ManyChat → Flow → "..." → copy Flow ID). Leave unset to
# rely solely on the ai_state field gate.
MANYCHAT_PAUSE_FLOW_ID=
MANYCHAT_RESUME_FLOW_ID=
```

`MANYCHAT_API_TOKEN`, `MANYCHAT_ENABLED`, and `WEBHOOK_SHARED_SECRET` are already
covered in `manychat-setup.md` §2. All Public-API calls are **best-effort**: if
the token is missing or `MANYCHAT_ENABLED=false`, the backend logs a warning and
the DB remains the source of truth.

---

## 8. Standardise on ONE human-reply surface: the admin panel

ManyChat's native pause does **not** trigger when a human replies from the **raw
Facebook/Instagram app** — only from ManyChat's Inbox or flows. And ManyChat does
**not** replay the human↔customer conversation back to our backend. To keep state
consistent and to feed context back to the AI, **send all human replies through
our admin panel** (`POST /admin/conversations/:id/messages`):

- The message is recorded as a `role: human` row and delivered to the customer via
  the Send API (`sendContent`) under the same contact id.
- It is **gated**: allowed only when `ai_state != bot` (pause or hand off first).
- It is **idempotent**: pass an `Idempotency-Key` header to make retries safe.

When you resume, put the human's wrap-up in the resume body
(`{ "summary": "..." }`). It is stored in `ai_human_summary` / the DB and
**injected into the agent's next turn once**, then cleared — so the AI resumes
aware of what the human did. (ManyChat's own Inbox may still be used to *read* the
thread, but outbound human messages should go through the panel.)

---

## 9. Audit trail

Every transition (pause, resume, assign, handoff, human_message, and agent-driven
escalation) writes a row to **`conversation_events`** (actor, actor type,
from→to state, reason, metadata, timestamp). This is the source for an admin
activity log; it is append-only and cascades on conversation delete.

---

## 10. Checklist before going live

- Migration `0012` applied (`bunx drizzle-kit migrate`).
- Custom fields `ai_state`, `ai_handoff_reason`, `ai_human_summary` created (§2);
  new contacts initialised to `ai_state = bot`.
- External Request gated on `ai_state == bot` (§3).
- Handoff node runs **Pause + Assign** in one node off the `ai_human` tag (§4).
- Native pause duration chosen deliberately (finite for auto-recovery, indefinite
  for human-only resume) (§5).
- Optional pause/resume flow IDs set in `.env` if used (§6/§7).
- `MANYCHAT_AI_STATE_FIELD` / `MANYCHAT_HUMAN_TAG` match the names created in
  ManyChat (§7).
- Human replies go through `POST /admin/conversations/:id/messages` only (§8).
