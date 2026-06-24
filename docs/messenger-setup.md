# Meta Messenger Platform — Setup Runbook

This is the operator runbook for connecting the Masa Fashion AI-agent backend to
a Facebook Page using **Meta's Messenger Platform (Graph API v25.0)** directly —
no third-party middleware. The backend owns the inbound webhook, signature
verification, the Send API, and Click-to-Messenger attribution.

> **Verify against Meta's current docs.** Meta renames dashboard menus often.
> The env var names, endpoints, and the request/response shapes below are exact
> to this codebase; the dashboard click-paths are accurate as of writing but
> confirm them at <https://developers.facebook.com/docs/messenger-platform> if a
> label has moved.

---

## 0. What you connect (one diagram)

```
Customer → Facebook Page → Meta Messenger Platform
                              │  (signed webhook, X-Hub-Signature-256)
                              ▼
                  POST /webhook/messenger  ──▶  AgentService (async)
                              ▲                        │
   GET /webhook/messenger ────┘ (one-time verify)      ▼
                                          Graph Send API: POST /{PAGE_ID}/messages
                                          (Bearer Page token) → Customer
```

- **Inbound:** Meta calls `GET /webhook/messenger` once to verify, then
  `POST /webhook/messenger` for every event (signed).
- **Outbound:** the backend replies via `POST https://graph.facebook.com/v25.0/{PAGE_ID}/messages`
  with the Page access token in the `Authorization` header.
- **Identity:** the agent keys memory by the Facebook **PSID** (`event.sender.id`).

---

## 1. Environment variables

All Messenger config lives in these env vars (defined in
`src/core/config/env.schema.ts`, documented in `.env.example`). In **production**
the first four are **required** — the app fails fast at boot if any is unset.

| Env var | Required | Source (dashboard) | Used for |
|---|---|---|---|
| `MESSENGER_VERIFY_TOKEN` | prod | You choose any strong string | Echoing `hub.challenge` on the GET verify handshake |
| `MESSENGER_APP_SECRET` | prod | App → Settings → Basic → **App Secret** | Validating `X-Hub-Signature-256` (HMAC-SHA256) on every POST |
| `MESSENGER_PAGE_ID` | prod | The connected Page's id | Send API URL: `POST /{PAGE_ID}/messages` |
| `MESSENGER_PAGE_ACCESS_TOKEN` | prod | App → Messenger → **Generate token** (long-lived) | `Authorization: Bearer <token>` on Send API calls |
| `MESSENGER_GRAPH_VERSION` | optional | — (default `v25.0`) | The single Graph API version pin |
| `META_ADS_ACCESS_TOKEN` | optional | Marketing API token | Resolving `ad_id` → campaign/adset names for richer attribution |

```dotenv
# --- Meta Messenger Platform (direct Graph API, v25.0) ---
MESSENGER_VERIFY_TOKEN=
MESSENGER_APP_SECRET=
MESSENGER_PAGE_ID=
MESSENGER_PAGE_ACCESS_TOKEN=
# MESSENGER_GRAPH_VERSION=v25.0
# META_ADS_ACCESS_TOKEN=
```

> **Dev fallback:** if `MESSENGER_APP_SECRET` is unset in non-production, POST
> signature validation is **skipped** (one warning logged) so you can curl the
> webhook locally. In production an unset secret rejects **every** POST with 401.

---

## 2. Create the Meta app and add Messenger

1. Go to <https://developers.facebook.com/apps> → **Create App**.
2. Pick the **Business** app type (required for `pages_messaging`). Attach it to
   the Business portfolio that owns the Masa Fashion Page.
3. On the app dashboard, **Add Product → Messenger → Set up**.

### Get the App Secret and pick a Verify Token

- **App Secret:** App → **Settings → Basic** → reveal **App Secret**. Put it in
  `MESSENGER_APP_SECRET`. This is the HMAC key Meta signs every webhook POST with.
- **Verify Token:** invent a strong random string (e.g. `openssl rand -hex 24`).
  Put the same value in `MESSENGER_VERIFY_TOKEN` **and** the dashboard webhook
  config (next step). It is only used during the GET verify handshake.

---

## 3. Configure the webhook (Callback URL + Verify Token)

In Messenger product settings, find the **Webhooks** (or **Configure webhooks**)
section and add a callback:

| Field | Value |
|---|---|
| **Callback URL** | `https://<your-host>/webhook/messenger` |
| **Verify Token** | the exact value of `MESSENGER_VERIFY_TOKEN` |

Click **Verify and Save**.

### What the GET handshake does

When you click Verify, Meta sends:

```
GET /webhook/messenger?hub.mode=subscribe&hub.verify_token=<your-token>&hub.challenge=<random>
```

The backend (`messenger-webhook.controller.ts`):
- echoes the raw `hub.challenge` as `text/plain` with **200** when
  `hub.mode === "subscribe"` **and** `hub.verify_token === MESSENGER_VERIFY_TOKEN`;
- otherwise returns **403**.

If Verify fails: the token doesn't match, the URL isn't reachable over public
HTTPS, or the server isn't running. The GET route is **not** signature-guarded
(Meta sends no HMAC on verification).

### Public HTTPS in development

Meta requires a publicly reachable **HTTPS** URL with a valid (non-self-signed)
certificate. Locally, put a tunnel in front of `http://localhost:3000`:

```bash
# cloudflared (recommended — gives a trusted *.trycloudflare.com cert)
cloudflared tunnel --url http://localhost:3000
# → https://abc123.trycloudflare.com  → Callback URL = https://abc123.trycloudflare.com/webhook/messenger
```

The tunnel URL changes each run, so re-paste the Callback URL when it rotates.
For production use a stable domain with a real TLS certificate.

---

## 4. Connect the Page and get the token + Page id

Still in Messenger settings, under **Access Tokens** (or **Connect a Page**):

1. **Add/Connect** the Masa Fashion Page (you must have an admin role on it).
2. **Generate** a Page access token for that Page → `MESSENGER_PAGE_ACCESS_TOKEN`.
   - The dashboard token is typically short-lived. Exchange it for a
     **long-lived Page access token** so it does not expire (see Meta's
     [Access Tokens guide](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived));
     long-lived Page tokens generally do not expire while the app is active.
3. Copy the **Page id** → `MESSENGER_PAGE_ID`. (Page → About, or the dashboard's
   connected-Pages list.)

The backend sends the token in the `Authorization: Bearer …` header (never in the
URL), so it is not leaked in access logs or referrers.

---

## 5. Subscribe the Page to the right webhook fields

In the webhook config for the connected Page, subscribe to **exactly** these
fields (the agent ignores everything else):

- `messages` — inbound text, images, quick-reply payloads.
- `messaging_postbacks` — button/Get-Started postbacks.
- `messaging_referrals` — Click-to-Messenger / m.me referral events for returning
  users (attribution).

> Subscribing to extra fields (delivery/read receipts, etc.) is harmless — the
> normalizer drops content-less events — but unnecessary. Do **not** forget
> `messaging_referrals`, or returning-user ad attribution is lost.

---

## 6. Testers and App Review (going live)

- **Dev mode** reaches **only people with a role on the app** (admins,
  developers, testers). Add your test Messenger accounts under
  App → **App Roles / Roles → Testers** and accept the invite from that account.
- For the **public** (real customers) you need **Advanced Access** to the
  `pages_messaging` permission via **App Review**, which in turn typically
  requires **Business Verification** of the owning Business portfolio. Plan for
  review lead time before launch.
- Until approved, every customer who is not an app tester will not receive
  replies even though the webhook fires.

---

## 7. Sending messages — the rules baked into the client

The Send API client (`messenger.client.ts`) posts to
`POST https://graph.facebook.com/v25.0/{PAGE_ID}/messages` with
`Authorization: Bearer <PAGE_TOKEN>`. Two messaging modes only:

| Situation | `messaging_type` | tag |
|---|---|---|
| In-window agent reply (within Meta's 24h window) | `"RESPONSE"` | **none** |
| Human-initiated message outside the window | `"MESSAGE_TAG"` | `"HUMAN_AGENT"` |

**Deprecated message tags are gone.** `ACCOUNT_UPDATE`, `CONFIRMED_EVENT_UPDATE`,
and `POST_PURCHASE_UPDATE` were retired by Meta and now return Graph **error 100**
(since 2026-04-27). Only `HUMAN_AGENT` is used, and only on the human-agent path.

The reply choreography per debounced batch is: `mark_seen` → `typing_on` →
text → product carousel (generic template, ≤8 cards) → `typing_off`, with a
graceful Arabic fallback text if the async worker throws.

---

## 8. How a signed POST is validated

Every inbound `POST /webhook/messenger`:

1. Meta sends header `X-Hub-Signature-256: sha256=<hex>`, where `<hex>` =
   HMAC-SHA256 of the **raw request body** keyed with `MESSENGER_APP_SECRET`.
2. The `MessengerSignatureGuard` recomputes the HMAC over `req.rawBody` and
   compares with `timingSafeEqual`. Missing, malformed, duplicated (array), or
   non-matching header → **401**. (In non-prod with no secret set: skipped.)
3. On success the controller returns **200 immediately** and processes the agent
   turn **asynchronously** (debounced). Duplicate events are deduped by
   `message.mid`. A bad/non-`page` body is ignored but still answered 200 (never
   bounce Meta).

---

## 9. Click-to-Messenger attribution — the `ref` convention

Click-to-Messenger ads and `m.me` links can carry a **`ref`** payload that the
backend persists as **first-touch** attribution on the conversation.

### How to set `ref`

- **m.me link:** `https://m.me/<PAGE_USERNAME>?ref=<your-ref>` — e.g.
  `?ref=masa-promo-eid` or `?ref=sku_AB123` to encode the promoted product's SKU.
- **Click-to-Messenger ad:** in Ads Manager, the messaging ad's "ref"/welcome
  payload field carries the same string into the referral.

The `ref` is a string you control — keep it short, URL-safe, and meaningful
(campaign slug, or the product SKU so it resolves against the catalog — see below).

### How it flows in (precedence)

The normalizer reads the referral with this precedence (`messenger.normalizer.ts`):

1. **`message.referral`** — a brand-new user's *first message* from a
   Click-to-Messenger ad (the primary case).
2. **`event.referral`** — a returning user's `messaging_referrals` event.
3. **`postback.referral`** — the Get-Started button case.

Fields captured: `ref`, `ad_id`, `source`, and `ads_context_data` (which may
include a `product_id`).

### What the backend does with it

- **First-touch only:** attribution is written **once** per conversation (an
  `attributed_at IS NULL` guard); later referrals don't overwrite it.
- **Persisted on the conversation row** (`ad_id`, `ad_ref`, `ad_source`,
  `ad_product_id`, `ad_context`).
- **Product resolution is best-effort:** if `ads_context_data.product_id` is
  present, the backend looks it up via `findPublishedBySku` against
  `products.sku` (**published products only**). A miss is non-fatal — the raw
  `product_id` is kept and nothing breaks.
- A content-less `messaging_referrals` event (no text/image) still persists
  attribution without starting an agent turn.

---

## 10. Local-dev checklist

1. **Env:** set `MESSENGER_VERIFY_TOKEN` and `MESSENGER_APP_SECRET` in `.env`.
   (`MESSENGER_PAGE_ID` / `MESSENGER_PAGE_ACCESS_TOKEN` only needed to actually
   send replies; without them sends are skipped with a warning.)
2. **Server:** `bun run start:dev` (binds `0.0.0.0:3000`).
3. **Tunnel:** `cloudflared tunnel --url http://localhost:3000`; use the printed
   HTTPS URL as the Callback URL `https://<tunnel>/webhook/messenger`.
4. **Verify (GET) by hand:**
   ```bash
   curl "http://localhost:3000/webhook/messenger?hub.mode=subscribe&hub.verify_token=$MESSENGER_VERIFY_TOKEN&hub.challenge=PING"
   # → PING            (200, plain text). Wrong/absent token → 403.
   ```
5. **Signed POST by hand:** the HMAC must match or you get 401.
   ```bash
   BODY='{"object":"page","entry":[{"messaging":[{"sender":{"id":"PSID-1"},"recipient":{"id":"PAGE-1"},"timestamp":1700000000000,"message":{"mid":"m1","text":"مرحبا"}}]}]}'
   SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$MESSENGER_APP_SECRET" | sed 's/^.* //')"
   curl -s -o /dev/null -w "%{http_code}\n" \
     -X POST http://localhost:3000/webhook/messenger \
     -H "Content-Type: application/json" \
     -H "X-Hub-Signature-256: $SIG" \
     --data "$BODY"
   # → 200  (a wrong/missing signature → 401)
   ```
   Confirm in the server log that the agent processed the turn asynchronously.
6. **Subscribe fields:** in the dashboard, subscribe the Page to `messages`,
   `messaging_postbacks`, `messaging_referrals` (step 5).
7. **DB migrated:** `bunx drizzle-kit migrate` so attribution columns exist.

---

## 11. Production go-live checklist

- `MESSENGER_VERIFY_TOKEN`, `MESSENGER_APP_SECRET`, `MESSENGER_PAGE_ID`,
  `MESSENGER_PAGE_ACCESS_TOKEN` all set (the app fails fast at boot otherwise).
- Page access token is the **long-lived** one.
- Callback URL is the stable production HTTPS domain (real TLS cert), verified.
- Page subscribed to `messages`, `messaging_postbacks`, `messaging_referrals`.
- **Advanced Access** to `pages_messaging` granted via App Review; Business
  Verification complete.
- `STORAGE_DRIVER=r2` so product-card image URLs are publicly reachable by the
  customer's Messenger client.
- Database migrated to the latest revision.

For conversation control and the AI↔human handoff state model, see
`docs/handoff-design.md`.
