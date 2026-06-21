import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestContext } from '@mastra/core/di';
import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import {
  ProductsService,
  type ProductSearchInput,
} from '@/modules/products/products.service';
import { ConversationsService } from '@/modules/conversations/conversations.service';
import { OrdersService } from '@/modules/orders/orders.service';
import { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import { AgentBehaviorService } from './agent-behavior.service';
import { SizingService } from '@/modules/sizing/sizing.service';
import { createHash } from 'node:crypto';
import { buildMastra } from './mastra/mastra.factory';
import { HANDOFF_REPLY } from './handoff.constants';
import { VisionService, type VisionExtractResult } from './vision/vision.service';
import { MAX_GALLERY_CARDS } from './manychat/manychat.formatter';

/** Window for the content-hash idempotency fallback when no provider id exists. */
const DEDUP_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Public I/O contracts
// ---------------------------------------------------------------------------

/**
 * Incoming message from ManyChat (via POST /agent/message).
 *
 * `contactId` is the ManyChat contact_id, which is stored in the `psid`
 * column.  ManyChat never exposes the real Facebook PSID; contact_id is
 * our stable subscriber identifier across all of this customer's threads.
 */
export interface IncomingMessage {
  /** ManyChat contact_id → resourceId (NOT the real Facebook PSID). */
  contactId: string;
  /** Customer message text. */
  text: string;
  /** Customer-sent image URL — accepted now; processing deferred to the vision phase. */
  lastImageUrl?: string;
  /** Self-controlled ref slug captured by ManyChat (e.g. "spring-ad-1"). */
  adRef?: string;
  /** ManyChat FB profile name — optional best-effort seed for working memory. */
  name?: string;
  /**
   * Inbound channel — sets the order `source` server-side (write tools read it
   * from requestContext, never from LLM input). Defaults to 'messenger' (the
   * current temp endpoint); 'whatsapp' is wired ahead of that integration.
   */
  channel?: 'messenger' | 'whatsapp';
  /**
   * Provider message id (ManyChat) used as the idempotency key for this turn.
   * Optional today; AgentService falls back to a content+time-window hash.
   */
  externalMessageId?: string;
}

/**
 * Agent reply returned to the controller and eventually to ManyChat.
 *
 * `price` is a STRING (JOD notation) to honour the money-as-string rule
 * (CLAUDE.md §3 — never use float for prices).  Phase 4 formats it for the
 * Dynamic Block card.
 *
 * `productOverflow` carries the count of matched products that exceeded the
 * rendered cap (8). When > 0 the formatter appends an Arabic overflow note.
 */
export interface AgentReply {
  reply: string;
  products?: Array<{ id: string; name: string; price: string }>;
  /** Number of matched products beyond the rendered cap. 0 when nothing overflows. */
  productOverflow?: number;
}

// ---------------------------------------------------------------------------
// Local structural type for generate() result introspection
// ---------------------------------------------------------------------------

/** Minimal local interface over the generate() return value for toolResults access. */
interface GenerateResult {
  text: string;
  toolResults?: Array<{
    payload?: {
      toolName?: string;
      result?: unknown;
      isError?: boolean;
      /** The tool input the model supplied (when the provider echoes it). */
      args?: unknown;
    };
  }>;
}

/**
 * Eval metadata persisted on an agent turn (messages.attributes.eval). It records
 * which products the agent surfaced and how, so the admin panel and the evals
 * harness (AIA-33) have ground-truth rows. `confirmed` starts null and a later
 * turn may set it once we know whether the customer accepted the match.
 */
interface EvalInfo {
  tool: 'search_products' | 'find_similar_by_image' | null;
  matched_product_ids: string[];
  search_params: unknown;
  image_led: boolean;
  confirmed: boolean | null;
}

/**
 * The Mastra agent runtime. Composes other domains strictly through their
 * exported services (never repositories or the database directly).
 *
 * Injected services:
 *  - ProductsService  — catalog reads (search, availability, media).
 *  - ConversationsService — thread/context persistence + escalation.
 *  - OrdersService — COD draft capture.
 *
 * Lifecycle:
 *  - `onModuleInit` calls `buildMastra`, which constructs the single
 *    `PostgresStore` + `Mastra` instance with all domain tools wired in.
 *    The store's connection pool is owned by Mastra and stays alive for
 *    the process lifetime.
 *  - `handleMessage` is the ManyChat-ready entry point. Its body mirrors what
 *    ManyChat's External Request will POST; the Dynamic Block formatting and
 *    the real webhook are AIA-32 (Phase 4).
 *
 * Memory scoping:
 *  - `resourceId` = ManyChat contact_id — scopes working memory to the
 *    individual customer across all her threads.  The contact_id is stored in
 *    the `psid` column because ManyChat never exposes the real Facebook PSID;
 *    contact_id is our stable subscriber id.
 *  - `threadId` = `thread:{contactId}` — one continuous Messenger DM per
 *    contact; scopes message history to that single conversation window.
 *
 * RequestContext:
 *  - Populated before every generate() call with `contactId`, `conversationId`,
 *    `threadId`, `channel`, and (when present) `adRef`, plus `lastImageUrl` +
 *    `imageLed` on turns where the customer sent a photo (image-over-ad routing).
 *  - Write tools (capture_order, escalate_to_human) read identity from here —
 *    NEVER from their tool input schema (security boundary, per AIA-27).
 *
 * TODO (next ticket): close the PostgresStore pool on shutdown — implement
 *   OnModuleDestroy (await the store's close()) and call
 *   app.enableShutdownHooks() in main.ts so it fires on SIGTERM/redeploy.
 */
@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);

  /**
   * The root Mastra instance — owns the PostgresStore connection pool and the
   * agent registry. Retained for the process lifetime to keep the store alive.
   */
  private mastra!: Mastra;

  /** The compiled sales agent — call generate() on this. */
  private salesAgent!: Agent;

  constructor(
    private readonly config: ConfigService,
    private readonly products: ProductsService,
    private readonly conversations: ConversationsService,
    private readonly orders: OrdersService,
    private readonly agentBehavior: AgentBehaviorService,
    private readonly knowledge: KnowledgeService,
    private readonly sizing: SizingService,
    private readonly vision: VisionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    const { mastra, salesAgent } = buildMastra({
      connectionString,
      products: this.products,
      orders: this.orders,
      conversations: this.conversations,
      knowledge: this.knowledge,
      sizing: this.sizing,
      agentBehavior: this.agentBehavior,
    });
    this.mastra = mastra;
    this.salesAgent = salesAgent;

    this.logger.log(
      'Mastra ready: schema=mastra, model=claude-sonnet-4-6, workingMemory=resource, tools=10, instructions=dynamic',
    );
  }

  // ---------------------------------------------------------------------------
  // Cross-domain helpers (sanctioned call style: through exported services only)
  // ---------------------------------------------------------------------------

  /**
   * Example of the only sanctioned cross-domain call style: through the
   * exported service. The real agent exposes this via the search_products tool.
   */
  searchProducts(input: ProductSearchInput) {
    return this.products.search(input);
  }

  // ---------------------------------------------------------------------------
  // Agent I/O
  // ---------------------------------------------------------------------------

  /**
   * Handles an inbound customer message from ManyChat and returns the agent reply.
   *
   * Execution order:
   *  1. Derives `resourceId` (= contactId) and `threadId` (= `thread:{contactId}`).
   *  2. Ensures a Conversation row exists for this contact via findOrCreateByPsid.
   *     contactId is stored in the `psid` column because ManyChat never exposes
   *     the real Facebook PSID; contact_id is our stable subscriber id.
   *  2a. BOT-PAUSE GATE (code-enforced): if state.stage === 'needs_human', logs the
   *      inbound message and returns the handoff reply immediately — generate() is
   *      NOT called. This is the first check after obtaining the conversation row.
   *  3. Builds a RequestContext carrying `contactId`, `conversationId`, `threadId`,
   *     and `adRef` (when present) so that write tools can read customer identity
   *     without it appearing in the tool input schema (security boundary, AIA-27).
   *     contactId + adRef are carried for the runtime/tools per AIA-27.
   *  4. Optionally seeds the FB profile name into the system context so the agent
   *     can persist it to working memory (deferred refinement: the model won't
   *     overwrite a name it already knows).
   *  5. Persists business-log rows (public-schema messages table) BEFORE and AFTER
   *     generate — these are the admin panel + eval rows (diagram node T), NOT a
   *     duplicate of Mastra's LLM context store.
   *  6. Calls salesAgent.generate() with memory scoping and requestContext.
   *  7. Extracts search_products + find_similar_by_image results for the reply
   *     card (best-effort).
   */
  async handleMessage(input: IncomingMessage): Promise<AgentReply> {
    const resourceId = input.contactId;
    const threadId = `thread:${input.contactId}`;

    const convo = await this.conversations.findOrCreateByPsid(resourceId, {
      threadId,
      adRef: input.adRef,
    });

    // Idempotency: ignore a re-delivered inbound turn (webhook retry / double
    // tap). The key is the provider message id when present, else a content +
    // short-time-window hash. The partial unique index on messages.external_id
    // is the DB-level backstop against a concurrent race.
    const dedupKey = this.computeDedupKey(input);
    const alreadyProcessed = await this.conversations.findMessageByExternalId(
      convo.id,
      dedupKey,
    );
    if (alreadyProcessed) {
      // Duplicate — do nothing. Empty reply is dropped by the (future) adapter.
      return { reply: '' };
    }

    // Bot-pause gate (code-enforced): once a conversation is handed to a human
    // (escalate_to_human set state.stage='needs_human'), the bot stops replying.
    // We still log the inbound message so the human sees it, but skip the LLM.
    const state = convo.state as { stage?: string } | null;
    if (state?.stage === 'needs_human') {
      await this.logTurn({
        conversationId: convo.id,
        role: 'customer',
        content: input.text,
        externalId: dedupKey,
        ...(input.lastImageUrl ? { imageUrl: input.lastImageUrl } : {}),
      });
      return { reply: HANDOFF_REPLY };
    }

    // Build the trusted RequestContext that write tools read for identity.
    // Write tools read `conversationId` (identity) from here, never from model
    // input; contactId + adRef are carried for the runtime/tools per AIA-27.
    const requestContext = new RequestContext();
    requestContext.set('contactId', resourceId);
    requestContext.set('conversationId', convo.id);
    requestContext.set('threadId', threadId);
    // `source` for captured orders is derived from this channel, server-side.
    requestContext.set('channel', input.channel ?? 'messenger');
    if (input.adRef) {
      requestContext.set('adRef', input.adRef);
    }

    // Image-led routing injection: when the customer sent a photo this turn,
    // wire the URL into the request context and flag the turn as image-led.
    // The search_products tool reads `imageLed` and ignores `ad_ref` when true
    // (code-enforced: the design in the photo wins over the ad she came from).
    // The find_similar_by_image tool reads `lastImageUrl` directly from context
    // so it never appears in the tool input schema.
    let visionNote: string | undefined;
    if (input.lastImageUrl) {
      requestContext.set('lastImageUrl', input.lastImageUrl);
      requestContext.set('imageLed', true);

      // Vision pre-step (deterministic, best-effort): extract structured
      // attributes from the photo via Claude Haiku and seed them so the agent
      // searches by what she photographed. The design in the photo wins over the
      // ad, so this runs whenever a photo is present, regardless of adRef. The
      // service never throws; on any failure it returns no attributes and the
      // turn proceeds (the agent can still use find_similar_by_image or ask).
      const vision = await this.vision.extractAttributes({
        url: input.lastImageUrl,
      });
      if (vision.attributes) {
        requestContext.set('visionAttributes', vision.attributes);
        visionNote = this.buildVisionNote(vision);
      }
    }

    // Best-effort system context: the FB profile name seed (so the agent saves it
    // to working memory) and, when present, the vision attribute note. role:
    // 'system' is valid per @mastra/core's internal AI SDK SystemModelMessage.
    const systemMessages: Array<{ role: 'system'; content: string }> = [];
    if (input.name) {
      systemMessages.push({
        role: 'system',
        content: `اسم الزبونة من فيسبوك: ${input.name}`,
      });
    }
    if (visionNote) {
      systemMessages.push({ role: 'system', content: visionNote });
    }
    const context = systemMessages.length > 0 ? systemMessages : undefined;

    // Persist the business record BEFORE generating — public-schema rows for the
    // admin panel + eval (diagram node T), NOT a duplicate of Mastra's LLM context
    // store. Business-log writes are best-effort (see logTurn): a logging failure
    // must never deny the customer her reply.
    await this.logTurn({
      conversationId: convo.id,
      role: 'customer',
      content: input.text,
      externalId: dedupKey,
      ...(input.lastImageUrl ? { imageUrl: input.lastImageUrl } : {}),
    });

    // TODO (AIA-32 webhook): if generate() throws, the inbound row above is left
    //   without a matching reply. Handle generate failures there (idempotency +
    //   mark/clean the orphan turn) once the real ManyChat webhook owns delivery.
    const result = (await this.salesAgent.generate(input.text, {
      memory: { resource: resourceId, thread: threadId },
      requestContext,
      ...(context ? { context } : {}),
    })) as GenerateResult;

    // Persist the agent reply — best-effort business-log row, now carrying eval
    // metadata (matched products + tool + image_led) for the admin panel and the
    // evals harness (diagram node T). A logging failure never denies the reply.
    const evalInfo = this.buildEvalInfo(result, Boolean(input.lastImageUrl));
    await this.logTurn({
      conversationId: convo.id,
      role: 'agent',
      content: result.text,
      ...(evalInfo ? { attributes: { eval: evalInfo } } : {}),
    });

    const { products: extractedProducts, overflow } = this.extractProducts(result);
    return {
      reply: result.text,
      products: extractedProducts,
      ...(overflow > 0 ? { productOverflow: overflow } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Best-effort business-log write. The customer reply is the primary product;
   * a failure to persist the secondary admin/eval log row must never break it,
   * so this logs and swallows on error rather than propagating.
   */
  private async logTurn(
    message: Parameters<ConversationsService['addMessage']>[0],
  ): Promise<void> {
    try {
      await this.conversations.addMessage(message);
    } catch (err) {
      this.logger.warn(
        `Business-log write failed (conversation ${message.conversationId}, ` +
          `role ${message.role}); continuing without it. ${String(err)}`,
      );
    }
  }

  /**
   * Extracts deduplicated product cards from search_products tool results,
   * together with the overflow count (total matched − rendered cap).
   *
   * Defensive + best-effort: the whole body is wrapped in try/catch so a
   * malformed toolResults payload NEVER breaks the reply to the customer.
   * Returns `{ products: undefined, overflow: 0 }` when there are no products
   * to surface.
   *
   * The cap is MAX_GALLERY_CARDS rendered cards (shared with the formatter so
   * the rendered count and overflow math never drift). Overflow = total deduped
   * products − cap, clamped to 0 (never negative).
   */
  private extractProducts(result: GenerateResult): {
    products: AgentReply['products'];
    overflow: number;
  } {
    try {
      const chunks = result.toolResults ?? [];

      const allProducts = chunks
        .filter(
          (c) =>
            (c.payload?.toolName === 'search_products' ||
              c.payload?.toolName === 'find_similar_by_image') &&
            !c.payload?.isError,
        )
        .flatMap((c) => {
          const raw = c.payload?.result as
            | { products?: Array<{ id: string; name: string; price: string; available?: boolean }> }
            | undefined;
          return raw?.products ?? [];
        });

      // Dedupe by id (first occurrence wins) — collect ALL deduped, then cap.
      const seen = new Set<string>();
      const deduped: Array<{ id: string; name: string; price: string }> = [];
      for (const p of allProducts) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        deduped.push({ id: p.id, name: p.name, price: p.price });
      }

      const rendered = deduped.slice(0, MAX_GALLERY_CARDS);
      const overflow = Math.max(0, deduped.length - MAX_GALLERY_CARDS);

      return {
        products: rendered.length > 0 ? rendered : undefined,
        overflow,
      };
    } catch {
      return { products: undefined, overflow: 0 };
    }
  }

  /**
   * Idempotency key for an inbound turn.
   *
   * WHY: ManyChat has no stable per-message id on all entry points (an
   * External Request fires once per customer message, but webhook retries or
   * double-taps can deliver the same content twice). We need a key that
   * collapses re-deliveries within a short window while still letting a
   * genuine new message with the same text through in a later window.
   *
   * RULE:
   *  1. If the provider supplied an explicit message id (e.g. from
   *     {{last_sent_message_id}} in the ManyChat flow body), use it as-is.
   *     This is the most reliable key and de-dupes perfectly.
   *  2. Otherwise, hash (contactId | normalizedText | imageUrl | 10s-window).
   *     Text is normalized — trimmed, internal whitespace collapsed, lowercased —
   *     so trivially-different casing or extra spaces collapse to the same key.
   *     The 10-second window lets a genuine repeat from the same customer in a
   *     later window produce a different hash and be processed normally.
   *
   * The partial unique index on messages.external_id (migration 0011) is the
   * DB-level backstop against a concurrent race between two in-flight requests.
   */
  private computeDedupKey(input: IncomingMessage): string {
    if (input.externalMessageId) return input.externalMessageId;
    // Normalize text: trim outer whitespace, collapse internal runs to one
    // space, and lowercase — so "مرحبا  " and "مرحبا" hash identically.
    const normalizedText = input.text
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const window = Math.floor(Date.now() / DEDUP_WINDOW_MS);
    const digest = createHash('sha256')
      .update(
        `${input.contactId}|${normalizedText}|${input.lastImageUrl ?? ''}|${window}`,
      )
      .digest('hex')
      .slice(0, 40);
    return `h:${digest}`;
  }

  /**
   * Builds eval metadata from the product-bearing tool results: the first tool
   * that returned products, the deduped matched ids (cap 8, mirroring the card
   * list), the search params (when the provider echoes them), and whether the
   * turn was image-led. Returns undefined when no products were surfaced.
   * Best-effort: a malformed payload yields undefined, never a thrown error.
   */
  private buildEvalInfo(
    result: GenerateResult,
    imageLed: boolean,
  ): EvalInfo | undefined {
    try {
      const productChunks = (result.toolResults ?? []).filter(
        (c) =>
          (c.payload?.toolName === 'search_products' ||
            c.payload?.toolName === 'find_similar_by_image') &&
          !c.payload?.isError,
      );

      const seen = new Set<string>();
      const ids: string[] = [];
      for (const c of productChunks) {
        const raw = c.payload?.result as
          | { products?: Array<{ id: string }> }
          | undefined;
        for (const p of raw?.products ?? []) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          ids.push(p.id);
          if (ids.length === 8) break;
        }
        if (ids.length === 8) break;
      }

      if (ids.length === 0) return undefined;

      const first = productChunks[0];
      return {
        tool: (first?.payload?.toolName as EvalInfo['tool']) ?? null,
        matched_product_ids: ids,
        search_params: first?.payload?.args ?? null,
        image_led: imageLed,
        confirmed: null,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Formats vision-extracted attributes into a short Arabic system note that
   * steers the agent to search by the photographed design. When confidence is
   * low it also nudges a "قصدك هاي؟" confirmation before the order proceeds.
   */
  private buildVisionNote(vision: VisionExtractResult): string {
    const a = vision.attributes;
    if (!a) return '';
    const parts: string[] = [];
    const color = a.colorFamily ?? a.color ?? undefined;
    if (color) parts.push(`اللون: ${color}`);
    if (a.occasion) parts.push(`المناسبة: ${a.occasion}`);
    if (a.fabric) parts.push(`القماش: ${a.fabric}`);
    if (a.sleeveType) parts.push(`الكُمّ: ${a.sleeveType}`);
    const attrs = parts.length > 0 ? parts.join('، ') : 'غير واضحة';
    const lowConfidence = vision.reason === 'low_confidence';
    return (
      `الزبونة أرسلت صورة منتج. السمات المستخرجة منها (للاسترشاد فقط): ${attrs}. ` +
      'استخدمي search_products بهذه السمات (خصوصاً اللون) لإيجاد الأقرب' +
      (lowConfidence
        ? '، وبما أن الثقة منخفضة اعرضي الأقرب وأكّدي مع الزبونة «قصدك هاي؟» قبل إتمام الطلب.'
        : '.')
    );
  }
}
