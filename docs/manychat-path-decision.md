# Decision Record: ManyChat Primary Path — Sync vs Async

## Constraint

ManyChat's External Request block has a **hard timeout of 10 seconds**, confirmed
in ManyChat's own channels (the
[dynamic block docs](https://manychat.github.io/dynamic_block_docs/) and community
threads on the limit:
[1](https://community.manychat.com/ideas/webhook-10-second-timeout-limit-7425),
[2](https://community.manychat.com/ideas/adjustable-timeout-settings-for-external-http-requests-4854)).
If the backend does not return a valid HTTP response within 10 s, ManyChat aborts
the automation step and triggers the fallback content block. This timeout is not
configurable.

## Per-turn latency budget for this agent

A single agent turn composes several sequential or parallel stages. All times are
order-of-magnitude estimates on a typical hosted server:

| Stage | When it runs | Estimated p50 | Estimated p95 |
|---|---|---|---|
| Vision pre-step (Claude Haiku, attribute extraction) | Image turns only | ~800 ms | ~2 500 ms |
| `salesAgent.generate()` — first token (Claude Sonnet, system prompt + memory load) | Every turn | ~1 500 ms | ~3 500 ms |
| Tool call: `search_products` (color normalization + DB query) | Most turns | ~150 ms | ~500 ms |
| Tool call: `find_similar_by_image` (CLIP embedding + pgvector ANN) | Image turns | ~400 ms | ~1 200 ms |
| Tool call round-trip overhead (Mastra serialize/deserialize) | Per tool | ~50 ms | ~150 ms |
| Per-product image URL resolution (`getMedia` × N products, parallel) | Every turn with products | ~100 ms | ~400 ms |
| Network + serialization to ManyChat | Every turn | ~50 ms | ~200 ms |

A **fast text-only turn** with a single `search_products` call totals roughly
1.9 s (p50) — well within budget.

An **image turn** (vision pre-step + `find_similar_by_image` + `search_products`
+ image resolution) totals roughly 3.0 s (p50) up to 8.3 s (p95). The p95
approaches or exceeds the 10 s budget, making timeout a realistic risk.

A **multi-tool text turn** (e.g. agent calls `search_products` then
`check_availability` then `get_product_media`) similarly pushes toward the limit
at p95.

## Decision

**The async path (`POST /webhook/manychat/async`) is the default and recommended
route.** It returns 202 immediately, debounces rapid messages, runs the full agent
pipeline out-of-band, and delivers the reply via the ManyChat Send API — so the
10 s wall clock never applies to the agent's work.

**The sync path (`POST /webhook/manychat`) is retained** for ManyChat flows that
require an inline Dynamic Block response (e.g. the External Request node's output
is consumed directly by a subsequent ManyChat step). It is appropriate only for
turns that are reliably fast (text-only, single tool, no image). In all other
cases the sync path risks a timeout.

The choice is made in the ManyChat flow: the External Request URL points at one
route or the other. A single flow can have separate External Request blocks wired
to the two routes — e.g. an image-input branch uses async, a quick-reply branch
uses sync.

## How this is reflected in the code

Both routes are implemented in
`src/modules/agent/manychat/manychat-webhook.controller.ts`:

- **Sync handler** (`handle`): calls `agent.handleMessage()` synchronously,
  enriches product images, and returns a Dynamic Block in the HTTP 200 body. It
  is wrapped in a try/catch that catches all errors and returns a valid block with
  a graceful Arabic fallback message — it NEVER returns 5xx, so ManyChat's
  automation is never halted by a backend error. The handler finishes exactly as
  fast as its own work takes; it does not add any artificial delay.

- **Async handler** (`handleAsync`): returns `{ status: 'accepted' }` with HTTP
  202 in the synchronous return (no await). The actual pipeline (debounce +
  agent + Send API delivery) is enqueued via `DebounceService` and runs in the
  background. A delivery failure is logged but does not surface to ManyChat.

The debounce window (`DEBOUNCE_WINDOW_MS`, default 2 000 ms) plus the agent
pipeline must finish before `DEBOUNCE_MAX_MS` (default 8 000 ms, hard cap below
the 10 s ManyChat timeout on the _async_ response leg, which is not constrained
by that timeout anyway since we already ACKed 202).

See `docs/manychat-setup.md` for the complete wiring guide, including which URL
to point the ManyChat flow at and how to configure the Send API path.
