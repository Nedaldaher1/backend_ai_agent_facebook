/**
 * MessengerWebhookController — Meta Messenger Platform (Graph API v25.0)
 * inbound webhook for the Masa Fashion AI sales-agent backend (WS2).
 *
 * Two routes:
 *  GET  /webhook/messenger  — Meta webhook verification (hub.challenge echo).
 *                             NOT signature-guarded (Meta sends no HMAC on GETs).
 *  POST /webhook/messenger  — Inbound events: messages, postbacks, referrals.
 *                             @HttpCode(200) (ACK synchronously, process async).
 *                             Guarded by MessengerSignatureGuard (HMAC-SHA256).
 *
 * Security (constraint #1):
 *  - POST is guarded by MessengerSignatureGuard (validates X-Hub-Signature-256).
 *  - GET is NOT guarded — Meta does not send signatures on verification requests.
 *
 * ACK then process (constraint #2):
 *  - POST always returns 200 synchronously.
 *  - Agent/DB work happens async OFF the request thread (via DebounceService).
 *  - Idempotent: duplicate mids are deduped by AgentService (external_id index).
 *  - Out-of-order safe: event.timestamp is carried into IncomingMessage.
 *
 * Reply choreography (for each debounced batch):
 *  1. mark_seen
 *  2. agent.handleMessage
 *  3. If reply.ran && reply.reply: typing_on → send text → send carousel (if
 *     products) → typing_off.
 *  4. If !reply.ran (ai_state !== 'bot'): no send (agent already persisted the
 *     inbound; the gate is the single source of truth).
 *  5. Any async failure: log + try graceful Arabic fallback text via Messenger.
 */

import {
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProductsService } from '@/modules/products/products.service';
import { ConversationsService } from '@/modules/conversations/conversations.service';
import { AgentService, type IncomingMessage } from '../agent.service';
import { DebounceService } from '../debounce/debounce.service';
import { mergeTurns } from '../debounce/merge-turns';
import { MessengerSignatureGuard } from './messenger-signature.guard';
import { MessengerClient, type SenderAction } from './messenger.client';
import {
  formatMessengerReply,
  type MessengerCardProduct,
} from './messenger.formatter';
import { splitIntoBubbles, typingDelayMs, sleep } from './reply-pacing.util';
import { extractReferral, normalizeEvent } from './messenger.normalizer';
import type {
  InboundMessage,
  NormalizedReferral,
  RawMessagingEvent,
} from './messenger.types';
import {
  messengerVerifyQuerySchema,
  messengerWebhookBodySchema,
  type MessengerWebhookBody,
} from './messenger-webhook.dto';
import { FALLBACK_REPLY } from '../customer-reply.constants';

@ApiTags('Messenger')
@Controller('webhook')
export class MessengerWebhookController {
  private readonly logger = new Logger(MessengerWebhookController.name);
  private readonly verifyToken: string | undefined;
  /**
   * Voice-note transcription feature flag (opt-in: exactly 'true'). Gated HERE
   * so that flag-off reproduces the legacy behavior byte-for-byte: audio
   * attachments are stripped before they can start an agent turn, and a
   * voice-only event falls into the same content-less branch as today.
   */
  private readonly transcriptionEnabled: boolean;
  /** Human-like reply pacing config (resolved once; see env.schema). */
  private readonly pacing: {
    enabled: boolean;
    msPerChar: number;
    minMs: number;
    maxMs: number;
    maxBubbles: number;
  };

  constructor(
    private readonly agent: AgentService,
    private readonly products: ProductsService,
    private readonly conversations: ConversationsService,
    private readonly debounce: DebounceService,
    private readonly messengerClient: MessengerClient,
    private readonly config: ConfigService,
  ) {
    this.verifyToken =
      config.get<string>('MESSENGER_VERIFY_TOKEN') || undefined;
    this.transcriptionEnabled =
      config.get<string>('TRANSCRIPTION_ENABLED') === 'true';
    // Read a numeric env robustly: ConfigService returns numbers in prod (zod
    // coercion) but plain strings under test stubs — coerce + fall back.
    const numEnv = (key: string, def: number): number => {
      const raw = config.get(key);
      if (raw == null) return def;
      const n = Number(raw);
      return Number.isFinite(n) ? n : def;
    };
    this.pacing = {
      // Default ON: only the literal 'false' disables (single-message mode).
      enabled: config.get<string>('MESSENGER_HUMAN_PACING_ENABLED') !== 'false',
      msPerChar: numEnv('MESSENGER_TYPING_MS_PER_CHAR', 45),
      minMs: numEnv('MESSENGER_TYPING_MIN_MS', 700),
      maxMs: numEnv('MESSENGER_TYPING_MAX_MS', 2500),
      maxBubbles: numEnv('MESSENGER_MAX_BUBBLES', 4),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhook/messenger — Meta hub verification
  // ---------------------------------------------------------------------------

  @Get('messenger')
  @ApiOperation({
    summary: 'Meta webhook verification (hub.challenge echo)',
    description:
      'Meta sends hub.mode, hub.verify_token, hub.challenge during subscription ' +
      'setup. If hub.mode==="subscribe" and hub.verify_token matches the configured ' +
      'MESSENGER_VERIFY_TOKEN, respond with the raw hub.challenge string as plain ' +
      'text (200). Otherwise 403. NOT signature-guarded.',
  })
  verifyWebhook(
    @Query() query: Record<string, string>,
    @Res() res: FastifyReply,
  ): void {
    // Validate the query parameters first. An unparseable query (e.g. a field
    // exceeding its .max() cap, or missing required keys) falls through to 403.
    const parsed = messengerVerifyQuerySchema.safeParse(query);
    if (!parsed.success) {
      void res.status(403).send('Forbidden');
      return;
    }

    const mode = parsed.data['hub.mode'];
    const token = parsed.data['hub.verify_token'];
    const challenge = parsed.data['hub.challenge'];

    if (
      mode === 'subscribe' &&
      this.verifyToken &&
      token === this.verifyToken &&
      challenge
    ) {
      // Respond with the raw challenge as plain text (not JSON).
      void res.status(200).type('text/plain').send(challenge);
      return;
    }

    void res.status(403).send('Forbidden');
  }

  // ---------------------------------------------------------------------------
  // POST /webhook/messenger — inbound events
  // ---------------------------------------------------------------------------

  @Post('messenger')
  @HttpCode(200)
  @UseGuards(MessengerSignatureGuard)
  @ApiOperation({
    summary: 'Meta Messenger inbound events (async processing)',
    description:
      'Receives messages, postbacks, and referrals from the Meta Messenger ' +
      'Platform. Returns 200 synchronously; agent/DB work is processed async. ' +
      'Idempotent (deduped by message.mid). Signature-validated via ' +
      'X-Hub-Signature-256 (HMAC-SHA256 of rawBody keyed with MESSENGER_APP_SECRET).',
  })
  handleWebhook(@Req() req: FastifyRequest): { status: 'ok' } {
    // Parse and validate the body. The signature guard has already run; any
    // parse error here means Meta sent a malformed payload — just ignore it.
    let body: MessengerWebhookBody;
    try {
      body = messengerWebhookBodySchema.parse(req.body);
    } catch (err) {
      this.logger.warn(
        `Messenger webhook body parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'ok' }; // Still 200 — never bounce Meta.
    }

    // Constraint #2: body.object !== 'page' → ignore but still 200.
    if (body.object !== 'page') {
      return { status: 'ok' };
    }

    // Loop entries and messaging events, normalize, dedupe by mid, enqueue.
    // seen is scoped to the whole request (not per-entry) so a mid that
    // appears in two entries of the same POST is still deduplicated.
    const seen = new Set<string>();
    for (const entry of body.entry) {
      const messaging = entry.messaging ?? [];

      for (const event of messaging as RawMessagingEvent[]) {
        const normalized = this.filterAudio(normalizeEvent(event));

        if (!normalized) {
          // Content-less event (delivery receipt, read receipt, or a pure
          // messaging_referrals event with no message/postback text). If the
          // event carries a referral, persist first-touch attribution without
          // starting an agent turn.
          const referral = extractReferral(event);
          if (referral && Object.keys(referral).length > 0) {
            const psid = event.sender.id;
            void this.persistAttributionOnly(psid, referral).catch((err) =>
              this.logger.warn(
                `Attribution-only persist failed for PSID ${psid}: ${String(err)}`,
              ),
            );
          }
          continue;
        }

        // Dedupe by mid within this batch (AgentService has the DB-level backstop).
        if (normalized.mid) {
          if (seen.has(normalized.mid)) continue;
          seen.add(normalized.mid);
        }

        const incoming = this.toIncoming(normalized);
        this.debounce.enqueue(normalized.psid, incoming, (items) =>
          this.processBatch(normalized.psid, items),
        );
      }
    }

    return { status: 'ok' };
  }

  /**
   * Feature gate for voice notes: with TRANSCRIPTION_ENABLED off, strip the
   * audio attachment so behavior matches the pre-feature pipeline exactly —
   * a voice-only event becomes content-less (null) and takes the same branch
   * as today (referral-only attribution persists, everything else is skipped).
   */
  private filterAudio(msg: InboundMessage | null): InboundMessage | null {
    if (!msg || this.transcriptionEnabled || !msg.audioUrl) return msg;
    const rest: InboundMessage = { ...msg };
    delete rest.audioUrl;
    if (!rest.text && !rest.imageUrl) return null;
    return rest;
  }

  // ---------------------------------------------------------------------------
  // Async worker — debounce flush
  // ---------------------------------------------------------------------------

  /**
   * Run the agent on a merged batch and deliver the reply via Messenger.
   *
   * Choreography:
   *  1. mark_seen (tell Meta we saw the message)
   *  2. agent.handleMessage
   *  3. if reply.ran && reply.reply:
   *       typing_on → send text → send carousel (if products) → typing_off
   *  4. if !reply.ran: no send (ai_state is not 'bot'; gate is single source)
   *  5. any failure: log + attempt graceful Arabic fallback (never leave silent).
   *
   * Sender actions are best-effort (fire-and-forget catch) — failure must never
   * prevent the message from being sent.
   */
  private async processBatch(
    psid: string,
    items: IncomingMessage[],
  ): Promise<void> {
    try {
      // Step 1: mark_seen (best-effort)
      await this.safeTyping(psid, 'mark_seen');

      // Step 2: run the agent
      const reply = await this.agent.handleMessage(mergeTurns(items));

      // Step 3 / 4: deliver if the agent ran and produced a reply.
      if (!reply.ran) {
        // ai_state is not 'bot' — the gate already persisted the inbound log.
        return;
      }

      if (reply.reply) {
        // Deliver the reply as human-like bubbles: split on blank lines and send
        // each as its own message with a typing pause before it. When pacing is
        // disabled the whole reply goes out as one message (legacy behavior).
        const bubbles = this.pacing.enabled
          ? splitIntoBubbles(reply.reply, this.pacing.maxBubbles)
          : [reply.reply];
        for (const bubble of bubbles) {
          await this.safeTyping(psid, 'typing_on');
          if (this.pacing.enabled) await sleep(this.bubbleDelay(bubble.length));
          await this.messengerClient.sendText(psid, bubble);
        }

        // Send product carousel (if any), after the text bubbles.
        if (reply.products && reply.products.length > 0) {
          const cards = await this.enrichWithImages(reply.products);
          const payloads = formatMessengerReply({
            reply: '',
            products: cards,
            overflowCount: reply.productOverflow,
          });
          for (const p of payloads) {
            if (p.kind === 'template') {
              await this.messengerClient.sendTemplate(psid, p.elements);
            } else if (p.kind === 'text') {
              await this.messengerClient.sendText(psid, p.text);
            }
          }
        } else if (reply.productOverflow && reply.productOverflow > 0) {
          // Overflow note even without a carousel (edge case)
          const payloads = formatMessengerReply({
            reply: '',
            overflowCount: reply.productOverflow,
          });
          for (const p of payloads) {
            if (p.kind === 'text') {
              await this.messengerClient.sendText(psid, p.text);
            }
          }
        }

        // typing_off (best-effort)
        await this.safeTyping(psid, 'typing_off');
      }

      // Deliver product photos as standalone image messages (one per photo).
      // The agent calls get_product_media to SHOW the customer a product's
      // pictures; we send each here (Meta fetches the public image URL). Gated on
      // reply.images only (independent of reply.reply). Per-image best-effort: a
      // single failed image is logged and the remaining photos still send. Each
      // photo gets a typing pause too, for consistent human pacing.
      if (reply.images && reply.images.length > 0) {
        for (const url of reply.images) {
          await this.safeTyping(psid, 'typing_on');
          if (this.pacing.enabled) await sleep(this.bubbleDelay(0));
          try {
            await this.messengerClient.sendImage(psid, url);
          } catch (e) {
            this.logger.warn(`sendImage failed for ${psid}: ${e}`);
          }
        }
        await this.safeTyping(psid, 'typing_off');
      }
    } catch (err) {
      // Never leave the customer silent — try the graceful Arabic fallback.
      this.logger.error(
        `Messenger async batch failed for PSID ${psid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      try {
        await this.messengerClient.sendText(psid, FALLBACK_REPLY);
      } catch (sendErr) {
        this.logger.error(
          `Messenger fallback send also failed for PSID ${psid}: ${
            sendErr instanceof Error ? sendErr.message : String(sendErr)
          }`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Best-effort sender action (mark_seen / typing_on / typing_off): a failure is
   * logged and never blocks the actual message send.
   */
  private async safeTyping(psid: string, action: SenderAction): Promise<void> {
    await this.messengerClient
      .senderAction(psid, action)
      .catch((e) => this.logger.warn(`${action} failed for ${psid}: ${e}`));
  }

  /** Typing-simulation delay (ms) for a message of the given char length. */
  private bubbleDelay(length: number): number {
    return typingDelayMs(length, {
      perChar: this.pacing.msPerChar,
      min: this.pacing.minMs,
      max: this.pacing.maxMs,
    });
  }

  /** Map an InboundMessage to AgentService IncomingMessage. */
  private toIncoming(msg: InboundMessage): IncomingMessage {
    return {
      contactId: msg.psid,
      text: msg.text,
      ...(msg.imageUrl ? { lastImageUrl: msg.imageUrl } : {}),
      ...(msg.audioUrl ? { lastAudioUrl: msg.audioUrl } : {}),
      // adRef: carry the ref slug so the search_products tool can surface
      // ad-linked products even on turns where the full referral is present.
      ...(msg.referral?.ref ? { adRef: msg.referral.ref } : {}),
      ...(msg.name ? { name: msg.name } : {}),
      channel: 'messenger',
      ...(msg.mid ? { externalMessageId: msg.mid } : {}),
      // WS3 — full referral for first-touch attribution in AgentService.
      ...(msg.referral && Object.keys(msg.referral).length > 0
        ? {
            referral: {
              ...(msg.referral.ref ? { ref: msg.referral.ref } : {}),
              ...(msg.referral.adId ? { adId: msg.referral.adId } : {}),
              ...(msg.referral.source ? { adSource: msg.referral.source } : {}),
              ...(msg.referral.adsContext?.product_id
                ? { adProductId: msg.referral.adsContext.product_id }
                : {}),
              ...(msg.referral.adsContext
                ? { adContext: msg.referral.adsContext }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Persist first-touch attribution for a content-less Messenger referral event
   * (WS3). Handles messaging_referrals events that carry no text/image/postback,
   * which normalizeEvent returns null for — they still need attribution written.
   *
   * Runs best-effort (void + catch at call site). Race note: if a content-bearing
   * event for the same PSID is processed concurrently (debounce flush vs. this
   * path both calling findOrCreateByPsid), both paths write the same conversation
   * row and the attribution UPDATE's WHERE attributed_at IS NULL guard ensures
   * only the first one commits.
   */
  private async persistAttributionOnly(
    psid: string,
    referral: NormalizedReferral,
  ): Promise<void> {
    const convo = await this.conversations.findOrCreateByPsid(psid);
    await this.conversations.recordFirstTouchAttribution(convo.id, {
      adId: referral.adId,
      adRef: referral.ref,
      adSource: referral.source,
      adProductId: referral.adsContext?.product_id,
      adContext: referral.adsContext,
    });
  }

  /**
   * Resolve the primary image URL for each product card. Best-effort and per-
   * product: a single media lookup failure leaves that card image-less rather
   * than failing the whole reply.
   */
  private async enrichWithImages(
    products: Array<{ id: string; name: string; price: string }>,
  ): Promise<MessengerCardProduct[]> {
    return Promise.all(
      products.map(async (p) => {
        let imageUrl: string | undefined;
        try {
          const media = await this.products.getMedia(p.id);
          imageUrl = media[0]?.url;
        } catch {
          imageUrl = undefined;
        }
        return { id: p.id, name: p.name, price: p.price, imageUrl };
      }),
    );
  }
}
