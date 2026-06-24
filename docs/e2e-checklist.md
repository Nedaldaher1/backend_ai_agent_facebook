# Meta Messenger Integration — Live E2E Verification Checklist

This runbook verifies the Meta Messenger Platform (Graph API v25.0) integration
end-to-end against a real Meta app and Facebook Page. It must be run with real
credentials and a live server. All automated unit tests must pass
(`bun run test`) before starting this checklist.

Reference docs:
- Wiring guide: `docs/messenger-setup.md`
- Handoff state model: `docs/handoff-design.md`

---

## Prerequisites

### 1. Environment variables

Set the following in `.env` (copy from `.env.example`):

```dotenv
DATABASE_URL=postgres://...
ANTHROPIC_API_KEY=sk-ant-...               # real key (not the placeholder)
MESSENGER_VERIFY_TOKEN=...                  # any strong string; mirror in the Meta dashboard
MESSENGER_APP_SECRET=...                    # App → Settings → Basic → App Secret
MESSENGER_PAGE_ID=...                       # the connected Page id
MESSENGER_PAGE_ACCESS_TOKEN=...             # long-lived Page access token
# MESSENGER_GRAPH_VERSION=v25.0             # default; bump only here
PUBLIC_BASE_URL=https://...                 # filled after tunnel starts (step 2)
```

### 2. Start the tunnel and server

In two separate terminals:

```bash
# Terminal 1 — tunnel
cloudflared tunnel --url http://localhost:3000
# Copy the printed URL, e.g. https://abc123.trycloudflare.com

# Terminal 2 — start the server
bun run start:dev
```

Set `PUBLIC_BASE_URL` in `.env` to the tunnel URL and restart the dev server so
the new value is picked up. The Callback URL is `https://<tunnel>/webhook/messenger`.

### 3. Wire Meta

Follow `docs/messenger-setup.md` §3–§5 to set the Callback URL + Verify Token,
connect the Page, and subscribe the Page to `messages`, `messaging_postbacks`,
`messaging_referrals`. Add your test Messenger account as an app **Tester**
(Dev mode reaches only app roles).

---

## Checks

---

### Check 1 — Webhook verification (GET challenge handshake)

**Action:** In the Meta dashboard webhook config, click **Verify and Save** with
the Callback URL and `MESSENGER_VERIFY_TOKEN`. Or test the GET directly:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "$PUBLIC_BASE_URL/webhook/messenger?hub.mode=subscribe&hub.verify_token=$MESSENGER_VERIFY_TOKEN&hub.challenge=PING"
# Expected output: 200   (and the body is exactly: PING)
```

**Expected result:**
- Correct token → HTTP 200, body equals the raw `hub.challenge` (plain text).
- Wrong/missing token → HTTP 403 (`Forbidden`).

[ ] Pass   [ ] Fail

---

### Check 2 — Signature rejection (bad/missing `X-Hub-Signature-256` → 401)

**Action (wrong signature):** POST to `/webhook/messenger` with a bogus signature:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$PUBLIC_BASE_URL/webhook/messenger" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=deadbeef" \
  -d '{"object":"page","entry":[]}'
# Expected output: 401
```

**Action (missing header):** repeat with no `X-Hub-Signature-256` header at all.
Expected: HTTP 401.

**Expected result:**
- Both return HTTP 401 (NestJS `UnauthorizedException`, not an unhandled error).
- Server log shows the signature guard rejected it.

> Note: this requires `MESSENGER_APP_SECRET` to be set. With it unset in non-prod,
> the guard is skipped by design — set it for this check.

[ ] Pass   [ ] Fail

---

### Check 3 — Valid signed POST → 200 and async processing

**Action:** Send a real text message ("عندك عبايات؟") from the test Messenger
account, OR craft a correctly signed POST:

```bash
BODY='{"object":"page","entry":[{"messaging":[{"sender":{"id":"PSID-TEST"},"recipient":{"id":"'$MESSENGER_PAGE_ID'"},"timestamp":1700000000000,"message":{"mid":"m-e2e-1","text":"عندك عبايات؟"}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$MESSENGER_APP_SECRET" | sed 's/^.* //')"
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$PUBLIC_BASE_URL/webhook/messenger" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$BODY"
# Expected output: 200 (returned immediately)
```

**Expected result:**
- HTTP **200** returned synchronously (the ACK), before any agent work.
- The server log shows the agent ran asynchronously (debounce flush →
  `handleMessage`).
- The test account receives a readable Arabic reply via the Send API.

[ ] Pass   [ ] Fail

---

### Check 4 — Product-search turn shows a card carousel

**Action:** Send a product-search message from the test account, e.g.
"عندك عبايات حمراء؟" or "بدي عباية للسهرة". The catalog must have at least one
published product matching the query.

**Expected result:**
- The customer receives a reply text AND a generic-template carousel showing
  products with title, subtitle (`{price} د.أ`), and (if media exists) an image.
- The Send API call uses `messaging_type:"RESPONSE"` with **no** message tag.

[ ] Pass   [ ] Fail

---

### Check 5 — Overflow turn shows the "N more designs" note

**Action:** Trigger a search matching more than 8 published products (e.g.
"عبايات" if the catalog is large enough).

**Expected result:**
- The carousel shows at most **8** cards (Meta hard cap is 10; we cap at 8).
- A trailing text message contains the overflow count + Arabic invitation
  (e.g. "وعندي كمان 3 تصميم — قوليلي إذا بتحبي أعرضهنّ 🌸").

[ ] Pass   [ ] Fail

---

### Check 6 — Image turn drives the vision path

**Action:** Send a photo of an abaya from the test account.

**Expected result:**
- The webhook ACKs 200 quickly; processing is async.
- After a short delay (vision pre-step + LLM + tool calls ≈ 2–5 s), the customer
  receives a reply referencing the image and showing similar products.
- The server log shows the vision pre-step ran (`extractAttributes`) and
  `visionAttributes` were set on the RequestContext.

[ ] Pass   [ ] Fail

---

### Check 7 — Click-to-Messenger attribution (first-touch `ref`)

**Action:** From a *new* test PSID, open an `m.me/<page>?ref=sku_<KNOWN_SKU>`
link (or a Click-to-Messenger ad carrying that `ref`) and send the first message.

**Expected result:**
- The `conversations` row for that PSID has `ad_ref` set (and `ad_id`/`ad_source`
  if present), with `attributed_at` populated.
- If the `ref`/`ads_context_data.product_id` matches a **published** `products.sku`,
  the resolved product id is recorded (`ad_product_id`); a non-match is non-fatal.
- A second referral from the same PSID does **not** overwrite the first touch.

[ ] Pass   [ ] Fail

---

### Check 8 — Idempotency: duplicate `mid` → one reply

**Action:** Send the same signed POST twice with the same `message.mid` within a
few seconds (reuse the `BODY`/`SIG` from Check 3, mid `m-e2e-1`).

**Expected result:**
- Both HTTP responses are 200.
- The `messages` table contains exactly **one** inbound row with
  `external_id = 'm-e2e-1'`.
- The Anthropic API was called **once**, not twice (verify via server logs).

[ ] Pass   [ ] Fail

---

### Check 9 — Never silent: async failure → graceful Arabic fallback

**Action:** Force an internal failure (e.g. point `DATABASE_URL` at an invalid
value and restart), then trigger a valid signed POST.

**Expected result:**
- The webhook still returns **200** (the ACK is sent before async work).
- The async worker catches the error and sends the customer the graceful Arabic
  fallback text:
  `"لحظة من فضلك 🌸 عم نجهّزلك الرد، جرّبي تبعتي رسالتك بعد شوي."`
- The server log contains the original exception; the customer is never left
  silent.

[ ] Pass   [ ] Fail

---

## Completion

All 9 checks must pass before marking the Meta Messenger integration as
production-ready.

If any check fails, record the failure in the Linear issue comment (step 6 of
the standard flow) and create a fix branch before pushing.
