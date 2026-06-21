# ManyChat Integration — Live E2E Verification Checklist

This runbook verifies the hardened ManyChat integration end-to-end against a
real ManyChat account. It must be run with real credentials and a live server.
All automated unit tests must pass (`bun run test`) before starting this checklist.

Reference docs:
- Wiring guide: `docs/manychat-setup.md`
- Path decision (sync vs async): `docs/manychat-path-decision.md`

---

## Prerequisites

### 1. Environment variables

Set the following in `.env` (copy from `.env.example`):

```dotenv
DATABASE_URL=postgres://...
ANTHROPIC_API_KEY=sk-ant-...          # real key (not the placeholder)
MANYCHAT_API_TOKEN=...                # ManyChat → Settings → API → Create API Key
WEBHOOK_SHARED_SECRET=...            # any random string, ≥ 16 chars
PUBLIC_BASE_URL=https://...          # filled after tunnel starts (step 2)
MANYCHAT_ENABLED=true
```

### 2. Start the tunnel and server

In two separate terminals:

```bash
# Terminal 1 — tunnel
bun run tunnel
# Copy the printed URL, e.g. https://abc123.trycloudflare.com

# Terminal 2 — update .env with the tunnel URL, then start the server
bun run start:dev
```

Set `PUBLIC_BASE_URL` in `.env` to the tunnel URL printed in terminal 1 and
restart the dev server so the new value is picked up.

### 3. Wire ManyChat

Follow `docs/manychat-setup.md` §3 to configure the External Request block,
the `x-manychat-secret` custom header, and the field mapping. Verify the
shared secret in ManyChat matches `WEBHOOK_SHARED_SECRET` in `.env`.

---

## Checks

---

### Check 1 — Text-only turn renders a Dynamic Block

**Action:** Send a plain text message to the Facebook page (e.g. "عندك عبايات؟")
from a test Messenger account connected to ManyChat. Use the **sync** route
(`POST /webhook/manychat`).

**Expected result:**
- ManyChat's External Request returns HTTP 200.
- The subscriber receives a readable Arabic reply rendered directly by ManyChat
  from the Dynamic Block `content.messages` array.
- The response body in the ManyChat debug log has `version === "v2"`,
  `content.actions === []`, `content.quick_replies === []`.

[ ] Pass   [ ] Fail

---

### Check 2 — Shared-secret rejection (wrong header → 401)

**Action:** Send a POST directly to `{PUBLIC_BASE_URL}/webhook/manychat` using
curl with a wrong `x-manychat-secret` header:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$PUBLIC_BASE_URL/webhook/manychat" \
  -H "Content-Type: application/json" \
  -H "x-manychat-secret: wrong-secret" \
  -d '{"contactId":"test","text":"hi"}'
# Expected output: 401
```

**Expected result:**
- HTTP 401 is returned.
- The server log shows a NestJS UnauthorizedException (not an unhandled error).

**Action (missing header):** Repeat without the `x-manychat-secret` header at all:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$PUBLIC_BASE_URL/webhook/manychat" \
  -H "Content-Type: application/json" \
  -d '{"contactId":"test","text":"hi"}'
# Expected output: 401
```

**Expected result:** HTTP 401.

[ ] Pass   [ ] Fail

---

### Check 3 — Product-search turn shows a card gallery

**Action:** Send a product-search message from the Messenger test account, e.g.
"عندك عبايات حمراء؟" or "بدي عباية للسهرة". The product catalog must have at
least one published product matching the query.

**Expected result:**
- The subscriber receives a reply text AND a card gallery (carousel) showing
  one or more products with title, subtitle (`{price} د.أ`), and (if media
  exists) an image.
- The Dynamic Block `content.messages` array contains both a `type=text`
  message and a `type=cards` message.

[ ] Pass   [ ] Fail

---

### Check 4 — Overflow turn shows the "N more designs" note

**Action:** Trigger a search that matches more than 8 published products (e.g.
"عبايات" if the catalog is large enough). Alternatively, reduce the cap
temporarily in a test environment.

**Expected result:**
- The card gallery shows at most 8 cards.
- A trailing text message appears after the cards containing the overflow count
  and the Arabic invitation (e.g. "وعندي كمان 3 تصميم — قوليلي إذا بتحبي
  أعرضهنّ 🌸").
- Total `content.messages` length does not exceed 10.

[ ] Pass   [ ] Fail

---

### Check 5 — Image turn drives the vision path

**Action:** Send a photo of an abaya (or any garment) from the Messenger test
account. Use the **async** route (`POST /webhook/manychat/async`) to avoid the
10 s timeout risk on image processing.

**Expected result:**
- The sync request (if used) or the async ACK returns quickly (HTTP 200 or 202).
- After a short delay (vision pre-step + LLM + tool calls ≈ 2–5 s), the
  subscriber receives a reply that references the image and shows similar
  products.
- The server log shows the vision pre-step ran (`extractAttributes`) and
  `visionAttributes` were set on the RequestContext.

[ ] Pass   [ ] Fail

---

### Check 6 — Async path delivers via Send API

**Action:** Send a message via the **async** route
(`POST /webhook/manychat/async`). Confirm in the ManyChat Sending Log (ManyChat
→ Broadcasting or API logs) that the Send API call was made.

**Expected result:**
- The HTTP response is `{ "status": "accepted" }` with HTTP 202 immediately.
- After the debounce window (default 2 s) plus agent processing time, the
  subscriber receives the reply in Messenger.
- The server log shows `ManyChat send returned HTTP 200` (or `status:success`
  from ManyChat's API).

[ ] Pass   [ ] Fail

---

### Check 7 — Idempotency: double-send same message → one reply

**Action:** Simulate a webhook retry by sending the same payload twice within
10 seconds. Use curl with an explicit `messageId` field to be deterministic:

```bash
PAYLOAD='{"contactId":"test-c1","text":"مرحبا","messageId":"idempotency-test-001"}'
SECRET_HDR="x-manychat-secret: $WEBHOOK_SHARED_SECRET"

# First delivery
curl -s -X POST "$PUBLIC_BASE_URL/webhook/manychat" \
  -H "Content-Type: application/json" \
  -H "$SECRET_HDR" \
  -d "$PAYLOAD"

# Immediate retry (simulated re-delivery)
curl -s -X POST "$PUBLIC_BASE_URL/webhook/manychat" \
  -H "Content-Type: application/json" \
  -H "$SECRET_HDR" \
  -d "$PAYLOAD"
```

**Expected result:**
- Both HTTP responses are valid v2 Dynamic Blocks (HTTP 200).
- The second response has `content.messages === []` (empty, the dedup path).
- The database `messages` table contains exactly **one** inbound row with
  `external_id = 'idempotency-test-001'`.
- The Anthropic API was called **once**, not twice (verify via server logs or
  API usage dashboard).

[ ] Pass   [ ] Fail

---

### Check 8 — Never-5xx: backend failure → ManyChat receives a graceful fallback

**Action (server error simulation):** Stop the dev server or temporarily
introduce a forced error by setting `DATABASE_URL` to an invalid value and
restarting. Then trigger the sync webhook from ManyChat.

Alternatively, use a test endpoint that deliberately throws:
```bash
# With a broken DATABASE_URL the agent's handleMessage will throw when it
# tries to reach the DB. The controller must still return HTTP 200 + fallback.
curl -s -X POST "$PUBLIC_BASE_URL/webhook/manychat" \
  -H "Content-Type: application/json" \
  -H "x-manychat-secret: $WEBHOOK_SHARED_SECRET" \
  -d '{"contactId":"test","text":"مرحبا"}'
```

**Expected result:**
- HTTP response is **200** (not 500, never 5xx).
- The response body is a valid v2 Dynamic Block containing exactly one text
  message equal to:
  `"لحظة من فضلك 🌸 عم نجهّزلك الرد، جرّبي تبعتي رسالتك بعد شوي."`
- The server log contains an error line (with the original exception) but the
  request was not propagated as a 5xx.
- ManyChat's automation is not halted (no ManyChat-side error shown in the
  flow debug panel).

[ ] Pass   [ ] Fail

---

## Completion

All 8 checks must pass before marking the ManyChat integration as production-ready.

If any check fails, record the failure in the Linear issue comment (step 6 of
the standard flow) and create a fix branch before pushing.
