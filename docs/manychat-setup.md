# ManyChat End-to-End Setup Guide

This guide walks through wiring the Masa Fashion AI agent backend to a ManyChat
bot. Complete every step before testing live traffic.

---

## 1. Start the local tunnel (development only)

ManyChat's External Request must reach a public HTTPS URL. In development, use
the cloudflared tunnel already scripted in `package.json`:

```bash
bun run tunnel
```

cloudflared prints a URL like:

```
https://abc123.trycloudflare.com
```

Copy that URL. You will use it in two places:

- `.env` as `PUBLIC_BASE_URL=https://abc123.trycloudflare.com`
- The ManyChat External Request block URL (see step 3)

Restart the dev server (`bun run start:dev`) after changing `.env` so the new
`PUBLIC_BASE_URL` is picked up.

---

## 2. Configure environment variables

Add to your `.env` (copy from `.env.example` and fill in real values):

```dotenv
# Public tunnel URL (dev) or production domain
PUBLIC_BASE_URL=https://abc123.trycloudflare.com

# ManyChat API token — ManyChat → Settings → API → Create API Key
MANYCHAT_API_TOKEN=your-manychat-api-token

# Shared secret for inbound webhook auth (any random string, ≥16 chars)
# You will paste this into ManyChat as a custom header value.
WEBHOOK_SHARED_SECRET=your-random-shared-secret

# Optional: debounce tuning (milliseconds)
# DEBOUNCE_WINDOW_MS=2000   # wait this long for more messages to arrive
# DEBOUNCE_MAX_MS=8000      # hard cap — must be < 10 000 (ManyChat timeout)
```

---

## 3. Create the ManyChat External Request block

In ManyChat, open your flow and add an **External Request** action block.

### 3a. Choose the route

There are two routes. Use the **async** route for most cases.

| Route | URL | Use when |
|---|---|---|
| Sync | `POST {PUBLIC_BASE_URL}/webhook/manychat` | Turn will always complete in < 8 s (text-only, no image) |
| Async (recommended) | `POST {PUBLIC_BASE_URL}/webhook/manychat/async` | Any turn that may involve image vision or slow DB queries |

The sync route returns a Dynamic Block directly in the HTTP 200 response, which
ManyChat renders immediately. The async route returns 202 and delivers the reply
later via the Send API; ManyChat must render the response from a separate "Send
Message" step that shows after the External Request in the flow.

The ManyChat External Request hard timeout is **10 seconds**. The async path
avoids this constraint entirely.

### 3b. Method and URL

- Method: `POST`
- URL: `{PUBLIC_BASE_URL}/webhook/manychat` (sync) or `/webhook/manychat/async`

### 3c. Custom request header (shared secret)

Add one custom header so the backend can verify the request came from your flow:

| Header name | Header value |
|---|---|
| `x-manychat-secret` | `{WEBHOOK_SHARED_SECRET}` (the value from your `.env`) |

### 3d. Request body field mapping

Configure the request body as **JSON**. Map each ManyChat field to the key our
backend expects:

| Our DTO field | ManyChat field / value | Notes |
|---|---|---|
| `contactId` | `{{contact.id}}` | Numeric subscriber id — stable identifier |
| `text` | `{{last_input_text}}` | The message the subscriber just sent |
| `lastImageUrl` | `{{last_input_attachment_url}}` | Optional; only present if subscriber sent an image |
| `adRef` | `{{ref}}` | Optional; present only on ref-ad entry points |
| `name` | `{{contact.name}}` | Optional Facebook display name |
| `channel` | `"messenger"` | Hardcode for Messenger flows (`"whatsapp"` for WhatsApp) |
| `messageId` | `{{last_sent_message_id}}` | Optional idempotency key; omit if not available |

Example JSON body template in ManyChat:

```json
{
  "contactId": "{{contact.id}}",
  "text": "{{last_input_text}}",
  "lastImageUrl": "{{last_input_attachment_url}}",
  "adRef": "{{ref}}",
  "name": "{{contact.name}}",
  "channel": "messenger"
}
```

### 3e. Response handling (sync route only)

When using the sync route, the External Request block returns a **Dynamic Block
v2**. In ManyChat, set the response type to **Dynamic Block** and point it at
the response body. ManyChat will render the messages array directly.

The Dynamic Block shape:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "..." },
      {
        "type": "cards",
        "elements": [
          {
            "title": "...",
            "subtitle": "45.000 د.أ",
            "image_url": "https://...",
            "action_url": "https://...",
            "buttons": []
          }
        ],
        "image_aspect_ratio": "horizontal"
      }
    ],
    "actions": [],
    "quick_replies": []
  }
}
```

Notes:
- No `content.type` field — this is the Messenger channel shape.
- `actions` and `quick_replies` are always present as empty arrays.
- Maximum 10 messages, 10 gallery cards, 3 buttons per card.

---

## 4. Configure a fallback (critical)

ManyChat halts the automation if the External Request returns an error or a
malformed body. The backend's sync route is hardened against this (it NEVER
returns 5xx — any internal failure returns a valid block with a polite Arabic
message). But as a second safety net, configure a **fallback content block**
directly in ManyChat on the External Request node:

```
نعتذر، صار خلل بسيط. رح يردّ عليكي أحد من فريقنا بأقرب وقت.
```

This fires if the backend is completely unreachable (tunnel down, server crash,
DNS failure).

---

## 5. Verify the Send API (async path only)

After the async path delivers a reply, ManyChat's API returns:

```json
{ "status": "success", "data": { ... } }
```

`"status": "success"` means the Send API accepted the message, NOT that it was
delivered to the subscriber. Facebook's 24-hour messaging window applies; if the
subscriber has not interacted within the last 24 hours, the message may not be
deliverable outside of approved message tags. The backend uses
`message_tag: "ACCOUNT_UPDATE"` which covers order-status and transactional
notifications.

---

## 6. Checklist before going live

- `WEBHOOK_SHARED_SECRET` is set in production `.env` and matches the custom
  header value in the ManyChat flow.
- `MANYCHAT_API_TOKEN` is set (required for the async path to deliver replies).
- `PUBLIC_BASE_URL` is the production HTTPS domain (not the cloudflared tunnel).
- The ManyChat flow has a fallback block configured (step 4).
- `STORAGE_DRIVER=r2` in production so image URLs in product cards are publicly
  reachable by ManyChat and the subscriber's Messenger client.
- The database is migrated (`bun run db:migrate` or equivalent).
