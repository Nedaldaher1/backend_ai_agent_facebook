import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestContext } from '@mastra/core/di';
import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import type { Memory } from '@mastra/memory';
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
import {
  VisionService,
  type VisionExtractResult,
} from './vision/vision.service';
import { MAX_GALLERY_CARDS } from './messenger/messenger.formatter';
import { stripEmojis, stripImageMarkup } from './reply-sanitize.util';
import { FALLBACK_REPLY } from './customer-reply.constants';
import { formatCostMeta, type TurnUsage } from './token-cost.util';

/** Window for the content-hash idempotency fallback when no provider id exists. */
const DEDUP_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Public I/O contracts
// ---------------------------------------------------------------------------

/**
 * Incoming message from the Meta Messenger transport (via POST /agent/message).
 *
 * `contactId` carries the Facebook PSID, which is stored in the `psid` column
 * and used as the stable subscriber identifier (`resourceId`) across all of
 * this customer's threads.
 */
export interface IncomingMessage {
  /** Facebook PSID → resourceId. */
  contactId: string;
  /** Customer message text. */
  text: string;
  /** Customer-sent image URL — accepted now; processing deferred to the vision phase. */
  lastImageUrl?: string;
  /** Self-controlled ref slug from the Messenger referral payload (e.g. "spring-ad-1"). */
  adRef?: string;
  /** Facebook profile name — optional best-effort seed for working memory. */
  name?: string;
  /**
   * Inbound channel — sets the order `source` server-side (write tools read it
   * from requestContext, never from LLM input). Defaults to 'messenger' (the
   * current temp endpoint); 'whatsapp' is wired ahead of that integration.
   */
  channel?: 'messenger' | 'whatsapp';
  /**
   * Provider message id (Messenger mid) used as the idempotency key for this turn.
   * Optional; AgentService falls back to a content+time-window hash when absent.
   */
  externalMessageId?: string;
  /**
   * First-touch referral data extracted from the Messenger event (WS3).
   * Passed from the controller's normalizeEvent/extractReferral; used by
   * AgentService to persist first-touch attribution after findOrCreateByPsid.
   */
  referral?: {
    ref?: string;
    adId?: string;
    adSource?: string;
    adProductId?: string;
    adContext?: unknown;
  };
}

/**
 * Agent reply returned to the controller and sent via the Meta Messenger API.
 *
 * `price` is a STRING (JOD notation) to honour the money-as-string rule
 * (CLAUDE.md §3 — never use float for prices).
 *
 * `productOverflow` carries the count of matched products that exceeded the
 * rendered cap (8). When > 0 the formatter appends an Arabic overflow note.
 *
 * `ran` indicates whether the agent actually ran generate() for this turn:
 *  - true  → the generate() path executed (aiState === 'bot').
 *  - false → the turn was skipped (dedup early-return OR ai_state !== 'bot').
 * Callers (Messenger controller) use this to decide whether to send a reply.
 *
 * `aiState` reflects the conversation's ai_state at the time of the return:
 *  - 'bot'    → normal active conversation.
 *  - 'human'  → conversation is under human handling.
 *  - 'paused' → conversation is temporarily paused.
 * Populated on all three return paths so callers can react accordingly.
 */
export interface AgentReply {
  reply: string;
  products?: Array<{ id: string; name: string; price: string }>;
  /** Number of matched products beyond the rendered cap. 0 when nothing overflows. */
  productOverflow?: number;
  /**
   * Product image URLs to deliver as standalone image messages (one per photo),
   * drained from the per-turn `mediaSink` the get_product_media tool fills (its
   * own result is a colour summary with no URLs). Omitted when the turn surfaced
   * no photos. The Messenger controller sends each via MessengerClient.sendImage.
   */
  images?: string[];
  /**
   * Whether the agent ran generate() this turn.
   * false on dedup early-return and on not-bot gate returns.
   * true on the normal end-of-turn path.
   */
  ran: boolean;
  /** The conversation's ai_state at the time of the return. */
  aiState?: 'bot' | 'human' | 'paused';
  /**
   * Token usage for the turn (summed over the empty-reply retry when it fires),
   * surfaced so callers — the eval harness above all — can report consumption
   * and estimated cost per case. Absent when the turn skipped generate().
   */
  usage?: TurnUsage & { steps?: number };
}

// ---------------------------------------------------------------------------
// Local structural type for generate() result introspection
// ---------------------------------------------------------------------------

/** Minimal local interface over the generate() return value for toolResults access. */
interface GenerateResult {
  text: string;
  /**
   * Why generation stopped ('stop' | 'length' | 'tool-calls' | …). Read
   * defensively (may be absent on some provider paths). Surfaced in the per-turn
   * log so an empty reply can be diagnosed — 'length' means the step was
   * truncated by the token cap.
   */
  finishReason?: string;
  toolResults?: Array<{
    payload?: {
      toolName?: string;
      result?: unknown;
      isError?: boolean;
      /** The tool input the model supplied (when the provider echoes it). */
      args?: unknown;
    };
  }>;
  /**
   * Token usage for the turn. Field names vary across AI SDK versions/providers
   * (v5: inputTokens/outputTokens/totalTokens; some report prompt/completion).
   * `cachedInputTokens` reflects the Gemini implicit cache (billed 0.25x via
   * OpenRouter). All optional — read defensively for the per-turn usage log.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  /** LLM round-trips (tool-calling steps) the turn took, when the SDK reports it. */
  steps?: unknown[];
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
 *  - `handleMessage` is the Meta Messenger entry point. It receives the
 *    normalised payload from the Messenger controller after debounce/merge.
 *
 * Memory scoping:
 *  - `resourceId` = Facebook PSID (`contactId`) — scopes working memory to the
 *    individual customer across all her threads. Stored in the `psid` column.
 *  - `threadId` = `thread:{contactId}` — one continuous Messenger DM per
 *    PSID; scopes message history to that single conversation window.
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

  /**
   * Per-turn generation tuning forwarded to the model on every generate()
   * (Mastra modelSettings → AI SDK v5 CallSettings). Config-driven
   * (AGENT_TEMPERATURE / AGENT_TOP_P / AGENT_MAX_OUTPUT_TOKENS). Set in
   * onModuleInit; applied at the single generate() call site so it governs
   * every customer turn without abusing the model fallback-array form.
   */
  private modelSettings!: {
    temperature: number;
    topP: number;
    maxOutputTokens: number;
  };

  /**
   * Max sequential tool-calling round-trips per customer message (Mastra
   * maxSteps). Each step re-sends the full prompt, so this bounds per-message
   * token cost. Config-driven (AGENT_MAX_STEPS); set in onModuleInit.
   */
  private maxSteps!: number;

  /**
   * The sales-agent model id (AGENT_MODEL_ID) — kept for per-turn cost
   * estimation in the usage log (see token-cost.util).
   */
  private modelId!: string;

  /**
   * Knowledge pre-fetch note caps (AGENT_KNOWLEDGE_MAX_ENTRIES / _MAX_CHARS):
   * bound the RAG note injected into context every turn. Set in onModuleInit.
   */
  private knowledgeMaxEntries!: number;
  private knowledgeMaxChars!: number;

  /**
   * Knowledge pre-fetch gating (KNOWLEDGE_PREFETCH_MODE): 'gated' injects the
   * FAQ note only on FAQ-looking turns, 'always' = legacy every-turn injection,
   * 'off' = tool-only. Set in onModuleInit.
   */
  private knowledgePrefetchMode!: 'always' | 'gated' | 'off';

  /**
   * Whether to inject the last-shown products recap note (enabled whenever old
   * tool results are stripped from recalled history — the recap re-anchors
   * "the one you showed me" references those payloads used to resolve).
   */
  private historyRecapEnabled!: boolean;

  /**
   * Where per-turn dynamic notes ride (AGENT_CONTEXT_PLACEMENT): 'tail' keeps
   * the system prefix byte-stable for the provider's implicit prompt cache;
   * 'system' is the legacy placement. Set in onModuleInit.
   */
  private contextPlacement!: 'tail' | 'system';

  /**
   * The Mastra Memory instance (working memory + thread/message store). Held so
   * the admin "reset conversation" action can clear a customer's memory.
   */
  private memory!: Memory;

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
    // Model id is config-driven (AGENT_MODEL_ID) so it can be swapped without a
    // code edit. Defaults to Gemini 3.5 Flash via OpenRouter.
    const modelId =
      this.config.get<string>('AGENT_MODEL_ID') ??
      'openrouter/google/gemini-3.5-flash';
    this.modelId = modelId;
    // Generation tuning forwarded to the model on every turn (Mastra
    // modelSettings). Config-driven with the production defaults baked in;
    // env.schema validates/coerces, the `?? 'default'` keeps unit tests (which
    // mock ConfigService) honest. Number() guards against a string slipping
    // through either path.
    this.modelSettings = {
      temperature: Number(
        this.config.get<string>('AGENT_TEMPERATURE') ?? '0.5',
      ),
      topP: Number(this.config.get<string>('AGENT_TOP_P') ?? '0.8'),
      maxOutputTokens: Number(
        this.config.get<string>('AGENT_MAX_OUTPUT_TOKENS') ?? '768',
      ),
    };
    // Cap on tool-calling round-trips per message (see field doc). Number()
    // guards a string slipping through the mocked-config path in tests.
    this.maxSteps = Number(this.config.get<string>('AGENT_MAX_STEPS') ?? '6');
    this.knowledgeMaxEntries = Number(
      this.config.get<string>('AGENT_KNOWLEDGE_MAX_ENTRIES') ?? '3',
    );
    this.knowledgeMaxChars = Number(
      this.config.get<string>('AGENT_KNOWLEDGE_MAX_CHARS') ?? '500',
    );
    const rawPrefetchMode = this.config.get<string>('KNOWLEDGE_PREFETCH_MODE');
    this.knowledgePrefetchMode =
      rawPrefetchMode === 'always' || rawPrefetchMode === 'off'
        ? rawPrefetchMode
        : 'gated';
    this.contextPlacement =
      this.config.get<string>('AGENT_CONTEXT_PLACEMENT') === 'system'
        ? 'system'
        : 'tail';
    const lastMessages = Number(
      this.config.get<string>('AGENT_LAST_MESSAGES') ?? '10',
    );
    // History token diet (see mastra.factory): which tools' OLD results are
    // stripped from recalled history, and the hard token budget for it.
    const rawFilter = this.config.get<string>('AGENT_HISTORY_TOOL_FILTER');
    const historyToolFilter: 'fat' | 'all' | 'off' =
      rawFilter === 'all' || rawFilter === 'off' ? rawFilter : 'fat';
    const historyTokenLimit = Number(
      this.config.get<string>('AGENT_HISTORY_TOKEN_LIMIT') ?? '12000',
    );
    this.historyRecapEnabled = historyToolFilter !== 'off';
    // Mastra framework logger level (validated enum, defaults to 'info' in the
    // env schema). Controls Mastra's own diagnostics; per-turn tool-call lines
    // are logged by logToolCalls regardless.
    const logLevel =
      this.config.get<'debug' | 'info' | 'warn' | 'error' | 'silent'>(
        'MASTRA_LOG_LEVEL',
      ) ?? 'info';
    const { mastra, salesAgent, memory } = buildMastra({
      connectionString,
      products: this.products,
      orders: this.orders,
      conversations: this.conversations,
      knowledge: this.knowledge,
      sizing: this.sizing,
      agentBehavior: this.agentBehavior,
      modelId,
      logLevel,
      lastMessages,
      historyToolFilter,
      historyTokenLimit,
    });
    this.mastra = mastra;
    this.salesAgent = salesAgent;
    this.memory = memory;

    const { temperature, topP, maxOutputTokens } = this.modelSettings;
    this.logger.log(
      `Mastra ready: schema=mastra, model=${modelId}, temp=${temperature}, topP=${topP}, maxOutputTokens=${maxOutputTokens}, maxSteps=${this.maxSteps}, historyFilter=${historyToolFilter}, historyTokenLimit=${historyTokenLimit}, logLevel=${logLevel}, workingMemory=resource, tools=11, instructions=dynamic`,
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
   * Handles an inbound customer message from the Meta Messenger transport and
   * returns the agent reply.
   *
   * Execution order:
   *  1. Derives `resourceId` (= PSID / contactId) and `threadId` (= `thread:{contactId}`).
   *  2. Ensures a Conversation row exists for this contact via findOrCreateByPsid.
   *     The PSID is stored in the `psid` column as our stable subscriber id.
   *  2a. BOT-PAUSE GATE (code-enforced): if ai_state !== 'bot', logs the inbound
   *      message and returns silently (reply: '') — generate() is NOT called. The
   *      handoff line is delivered once on the escalation turn by the tool; all
   *      subsequent turns while paused or handed-off are silent.
   *  3. Builds a RequestContext carrying `contactId`, `conversationId`, `threadId`,
   *     and `adRef` (when present) so that write tools can read customer identity
   *     without it appearing in the tool input schema (security boundary, AIA-27).
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

    // WS3 — First-touch attribution: if the inbound message carries referral
    // data (Messenger transport only), persist it best-effort. The repository
    // UPDATE is atomic (WHERE attributed_at IS NULL) so only the first call
    // writes; duplicates are silent no-ops. We then attempt product resolution
    // by SKU (publish gate enforced) and merge the result into conversation
    // state so the agent knows which advertised product the customer came from.
    if (input.referral) {
      void this.persistAttribution(convo.id, input.referral).catch((err) =>
        this.logger.warn(
          `First-touch attribution failed for conversation ${convo.id}: ${String(err)}`,
        ),
      );
    }

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
      // Duplicate — do nothing. Empty reply is dropped by the adapter.
      return {
        reply: '',
        ran: false,
        aiState: convo.aiState as 'bot' | 'human' | 'paused',
      };
    }

    // Timed-pause expiry (auto-resume): a pause created with `durationMinutes`
    // stores `pausedUntil`, but the gate below only checks `aiState`. Nothing
    // else reads `pausedUntil`, so without this an elapsed *temporary* pause
    // would stay silent forever. If the window has passed, flip back to 'bot'
    // (record a system resume event) and let the turn proceed normally.
    let aiState = convo.aiState;
    if (
      aiState === 'paused' &&
      convo.pausedUntil &&
      convo.pausedUntil.getTime() <= Date.now()
    ) {
      await this.conversations.setAiState(convo.id, {
        aiState: 'bot',
        pausedUntil: null,
      });
      await this.conversations.recordEvent({
        conversationId: convo.id,
        type: 'resume',
        actorType: 'system',
        fromState: 'paused',
        toState: 'bot',
        reason: 'auto-resume: pause window elapsed',
      });
      aiState = 'bot';
    }

    // Secondary gate (code-enforced): the bot replies only when ai_state === 'bot'.
    // 'human'/'paused' → log the inbound for the human, skip generate(), stay silent.
    // The handoff line is delivered once on the escalation turn itself (the tool's
    // reply); subsequent turns are silent.
    if (aiState !== 'bot') {
      await this.logTurn({
        conversationId: convo.id,
        role: 'customer',
        content: input.text,
        externalId: dedupKey,
        ...(input.lastImageUrl ? { imageUrl: input.lastImageUrl } : {}),
      });
      // Make the silence explainable: without this line a paused/handed-off
      // conversation looks identical to a broken agent in the logs. Now the
      // operator can see WHY no reply went out (e.g. it was left paused).
      this.logger.log(
        `agent turn [${resourceId}] skipped: ai_state=${aiState} (no reply sent — resume to re-enable the bot)`,
      );
      return {
        reply: '',
        ran: false,
        aiState: aiState as 'bot' | 'human' | 'paused',
      };
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

    // get_product_media side-channel: the tool pushes the SERVICE-selected image
    // URLs into this per-turn sink (its own tool result is a colour summary with
    // no URLs). Drained after generate() into reply.images so the Messenger
    // controller sends each photo. Per-call array → no cross-turn shared state.
    const mediaSink: string[] = [];
    requestContext.set('mediaSink', mediaSink);

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
      // The customer's caption (if any) this turn — find_similar_by_image embeds
      // it together with the photo into one multimodal vector.
      if (input.text?.trim()) {
        requestContext.set('lastImageText', input.text.trim());
      }

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

    // Per-turn dynamic notes: the FB profile name seed (so the agent saves it
    // to working memory), the vision attribute note, the one-shot human-handoff
    // summary, the knowledge pre-fetch, and the last-shown recap.
    const notes: string[] = [];
    if (input.name) {
      notes.push(`اسم الزبونة من فيسبوك: ${input.name}`);
    }
    if (visionNote) {
      notes.push(visionNote);
    }
    // Handoff context feedback (WS7): on the first turn after an admin resume, the
    // human's wrap-up summary is injected once so the agent resumes with awareness
    // of what the human did, then cleared so later turns don't repeat it.
    let injectedHumanSummary = false;
    if (convo.humanSummary) {
      notes.push(
        `ملخص ما تم مع فريق الدعم أثناء التحويل: ${convo.humanSummary}`,
      );
      injectedHumanSummary = true;
    }

    // Deterministic knowledge pre-fetch (RAG): resolve the product in context
    // (photo this turn → product shown last turn → ad product) and inject its
    // published FAQ so the agent answers from store knowledge FIRST — regardless
    // of whether the LLM decides to call the get_knowledge tool. Best-effort:
    // undefined on miss/failure and the turn proceeds (the tool stays available).
    const knowledgeNote = await this.prefetchKnowledgeNote(input, convo);
    if (knowledgeNote) {
      notes.push(knowledgeNote);
    }

    // Last-shown recap: old tool results are stripped from recalled history
    // (ToolCallFilter), so re-anchor "اللي ورجيتيني ياها / التانية" references
    // deterministically with a one-line id+name+price summary of the products
    // surfaced last turn — ~100 tokens instead of the 800-2,000-token raw
    // payloads it replaces. Best-effort: undefined on any failure.
    if (this.historyRecapEnabled) {
      const recapNote = await this.buildShownProductsRecap(convo);
      if (recapNote) {
        notes.push(recapNote);
      }
    }

    // Placement (AGENT_CONTEXT_PLACEMENT). 'tail' (default): ONE user-role
    // context message carrying all notes, explicitly labelled as a system note.
    // Mastra routes context system messages into the same system bucket as the
    // instructions — i.e. BETWEEN the static instructions and everything else —
    // so any per-turn note there changes the request's system prefix bytes and
    // busts the provider's implicit prompt cache (Gemini cache reads bill at
    // 0.1x; the instructions + tool schemas are the big cacheable block).
    // Context user messages instead sort AFTER recalled history, right before
    // the customer's new message, and are never persisted to the thread.
    // 'system' restores the legacy per-note system messages.
    let context:
      | Array<{ role: 'system' | 'user'; content: string }>
      | undefined;
    if (notes.length > 0) {
      context =
        this.contextPlacement === 'system'
          ? notes.map((content) => ({ role: 'system' as const, content }))
          : [
              {
                role: 'user' as const,
                content:
                  '(ملاحظات نظام لهذا الدور — ليست رسالة من الزبونة؛ استخدميها ولا تقتبسيها):\n' +
                  notes.join('\n\n'),
              },
            ];
    }

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
    //   mark/clean the orphan turn) once the Messenger webhook owns delivery.
    const genOptions = {
      memory: { resource: resourceId, thread: threadId },
      requestContext,
      // Generation tuning (temperature/topP/maxOutputTokens) applied to every
      // turn. Mastra forwards it to the model as AI SDK v5 CallSettings. Set on
      // each generate() since v1.42's Agent ctor has no top-level modelSettings
      // (it lives on execution options / fallback array).
      modelSettings: this.modelSettings,
      // Bound the tool-calling round-trips for this message; each step re-sends
      // the full prompt, so this directly caps per-message token cost.
      maxSteps: this.maxSteps,
      ...(context ? { context } : {}),
    };

    let result = (await this.salesAgent.generate(
      input.text,
      genOptions,
    )) as GenerateResult;
    // Turn-level usage: normalized here, summed with the retry below when it
    // fires, so the log line and reply.usage always cover the WHOLE turn.
    let turnUsage = this.normalizeUsage(result);

    // Sanitise the reply DETERMINISTICALLY (the prompt/tools are not trusted):
    // strip image markup (photos go out as carousel cards, never as text links)
    // and strip emoji (the brand voice forbids them, so a slipped-in emoji is
    // removed here regardless of what the persona says).
    let replyText = stripEmojis(stripImageMarkup(result.text ?? ''));

    // Empty-generation guard. Gemini occasionally returns no text (a step
    // truncated by the token cap, or a transient blip). An empty reply is sent as
    // SILENCE — the Messenger worker only delivers when reply.reply is non-empty —
    // which the customer experiences as "the bot stopped" and the operator has to
    // restart it from the panel. Retry once; if still empty, fall back to a short
    // clean line so she always gets something. The write tools (capture_order,
    // escalate_to_human) are idempotent, so the retry never double-writes.
    // finishReason is logged (see logToolCalls) to reveal the cause.
    if (!replyText.trim()) {
      const reason = result.finishReason ?? 'unknown';
      // Retry only for failure modes a re-run can actually fix (length
      // truncation, or a transient error/other/unknown). Skip the DETERMINISTIC
      // reasons — 'stop' (model deliberately produced nothing), 'tool-calls' (hit
      // the maxSteps wall while still wanting tools; a re-run hits the same wall)
      // and 'content-filter' (a re-run yields the same block) — since retrying
      // those just burns another full generation, so fall straight to the fallback.
      const noRetry =
        reason === 'stop' ||
        reason === 'tool-calls' ||
        reason === 'content-filter';
      if (!noRetry) {
        this.logger.warn(
          `agent turn [${resourceId}] empty reply (finishReason=${reason}) — retrying once`,
        );
        result = await this.salesAgent.generate(input.text, genOptions);
        replyText = stripEmojis(stripImageMarkup(result.text ?? ''));
        turnUsage = this.sumUsage(turnUsage, this.normalizeUsage(result));
      }
      if (!replyText.trim()) {
        this.logger.warn(
          `agent turn [${resourceId}] empty reply (finishReason=${result.finishReason ?? 'unknown'}) — using fallback`,
        );
        replyText = FALLBACK_REPLY;
      }
    }

    // Per-turn observability: log which tools the agent called this turn, with the
    // args it supplied and a short result hint. Without this the backend gives no
    // signal of what the agent is doing — Mastra's own logger reports tool
    // *registration*, not per-call invocation. Best-effort (never throws).
    this.logToolCalls(result, resourceId, turnUsage);

    // One-shot handoff summary (WS7): clear it only AFTER a successful generate()
    // so a failed turn (Claude 429/5xx) leaves it intact for the retry instead of
    // losing the human's wrap-up context. Best-effort + fire-and-forget.
    if (injectedHumanSummary) {
      void this.conversations
        .clearHumanSummary(convo.id)
        .catch((err) =>
          this.logger.warn(`clearHumanSummary failed for ${convo.id}: ${err}`),
        );
    }

    // Persist the agent reply — best-effort business-log row, now carrying eval
    // metadata (matched products + tool + image_led) for the admin panel and the
    // evals harness (diagram node T). A logging failure never denies the reply.
    // replyText was sanitised (image markup + emoji stripped) at generation time.
    const evalInfo = this.buildEvalInfo(result, Boolean(input.lastImageUrl));
    await this.logTurn({
      conversationId: convo.id,
      role: 'agent',
      content: replyText,
      ...(evalInfo ? { attributes: { eval: evalInfo } } : {}),
    });

    const { products: extractedProducts, overflow } =
      this.extractProducts(result);
    const images = this.sanitizeMediaUrls(mediaSink);

    // Remember the product(s) shown to the customer this turn so the NEXT turn's
    // knowledge pre-fetch can resolve "the product she's asking about" even when
    // she sends no new photo. Best-effort + fire-and-forget; never overwrite a
    // prior value with an empty list.
    const shownProductIds = this.collectShownProductIds(result);
    if (shownProductIds.length > 0) {
      void this.conversations
        .mergeState(convo.id, { lastProductIds: shownProductIds })
        .catch((err) =>
          this.logger.warn(
            `mergeState(lastProductIds) failed for ${convo.id}: ${String(err)}`,
          ),
        );
    }

    return {
      reply: replyText,
      products: extractedProducts,
      ...(overflow > 0 ? { productOverflow: overflow } : {}),
      ...(images.length > 0 ? { images } : {}),
      ran: true,
      aiState: 'bot',
      ...(turnUsage
        ? {
            usage: {
              ...turnUsage,
              ...(Array.isArray(result.steps)
                ? { steps: result.steps.length }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Admin "reset conversation": wipe the agent's Mastra memory for a customer —
   * the resource-scoped working memory (name, size, preferred colours, …) AND
   * the thread's message history the LLM sees. After this the agent treats her
   * next message as a brand-new customer.
   *
   * `psid` is the customer identity (= resourceId; `conversations.psid`). The
   * thread id is derived the same way as handleMessage (`thread:{psid}`).
   *
   * Both steps are attempted even if one fails (an absent/empty thread or
   * working-memory record is NOT an error — `updateWorkingMemory` upserts the
   * resource row and `deleteThread` is a no-op on a missing thread, so a
   * legitimately-empty conversation clears cleanly). But a REAL failure (e.g.
   * storage unavailable) is logged at error and re-thrown so the admin endpoint
   * reports failure instead of a false success — a silently-swallowed failure
   * here previously let the agent keep remembering the customer after a "reset".
   * The business-data wipe (conversation `state`, the `public.messages` log) is
   * orchestrated by ConversationControlService — this method owns ONLY Mastra's
   * memory.
   */
  async resetConversationMemory(psid: string): Promise<void> {
    const resourceId = psid;
    const threadId = `thread:${psid}`;

    // Attempt BOTH steps even if one fails, collecting any errors so neither
    // failure masks the other; a real error is surfaced after both run.
    const errors: unknown[] = [];

    // 1. Clear resource-scoped working memory. It is keyed by resourceId and
    //    persists independently of the thread, so deleting the thread alone
    //    would NOT make the agent forget her name/size/colours.
    try {
      await this.memory.updateWorkingMemory({
        threadId,
        resourceId,
        workingMemory: '',
      });
    } catch (err) {
      errors.push(err);
      this.logger.error(
        `reset: clearing working memory FAILED for psid ${psid}: ${String(err)}`,
      );
    }

    // 2. Delete the thread and its message history (the LLM conversation window).
    try {
      await this.memory.deleteThread(threadId);
    } catch (err) {
      errors.push(err);
      this.logger.error(
        `reset: deleting thread FAILED for psid ${psid}: ${String(err)}`,
      );
    }

    // Surface a real failure: never report success when the wipe did not happen.
    if (errors.length > 0) {
      throw new Error(
        `reset: Mastra memory wipe failed for psid ${psid} (${errors.length} error(s)); see logs.`,
      );
    }
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
   * Per-turn tool-call observability.
   *
   * Logs ONE line per agent turn naming every tool the model invoked, the args
   * it passed (compacted/truncated) and a short result hint (product/image
   * counts when present). This is the only signal of what the agent actually did
   * this turn: Mastra's framework logger reports tool *registration* at boot, not
   * per-call invocation, and `generate()` does not log its own tool steps.
   *
   * Reads from `result.toolResults` (post-execution), whose payload carries
   * `toolName`, `isError`, `args` (echoed by the provider) and `result`.
   * Best-effort: the whole body is wrapped in try/catch — observability must
   * NEVER break the customer reply.
   */
  private logToolCalls(
    result: GenerateResult,
    resourceId: string,
    turnUsage?: TurnUsage,
  ): void {
    try {
      // finishReason + reply length make a truncated/empty turn diagnosable: an
      // empty turn now logs e.g. "finishReason=length textLen=0" instead of a
      // bare "(none)" that hides why no reply went out.
      // Per-turn token usage makes consumption visible (the dominant cost is the
      // re-sent prompt × steps); cached input tokens (Gemini implicit cache,
      // billed at the discounted cache-read rate) show when the provider reports
      // them, alongside the estimated USD cost and cache-hit share so the effect
      // of prompt/caching changes is directly comparable across turns.
      const u = turnUsage ?? this.normalizeUsage(result);
      const usageStr = u
        ? ` tokens(in=${u.inputTokens ?? '?'}${
            u.cachedInputTokens ? ` cached=${u.cachedInputTokens}` : ''
          } out=${u.outputTokens ?? '?'} total=${u.totalTokens ?? '?'})${formatCostMeta(this.modelId, u)}`
        : '';
      const stepsStr = Array.isArray(result.steps)
        ? ` steps=${result.steps.length}`
        : '';
      const meta = `finishReason=${result.finishReason ?? 'unknown'} textLen=${(result.text ?? '').length}${stepsStr}${usageStr}`;

      const calls = result.toolResults ?? [];
      if (calls.length === 0) {
        this.logger.log(`agent turn [${resourceId}] tools: (none) ${meta}`);
        return;
      }
      const summary = calls
        .map((c) => {
          const name = c.payload?.toolName ?? 'unknown';
          const mark = c.payload?.isError ? '✗' : '✓';

          // Compact, truncated args so the log shows WHAT the agent asked for
          // (e.g. which colour/occasion it searched). Args are absent when the
          // provider does not echo them — then we just show the tool name.
          let args = '';
          if (c.payload?.args !== undefined) {
            const s = JSON.stringify(c.payload.args);
            args = ` ${s.length > 120 ? `${s.slice(0, 117)}...` : s}`;
          }

          // Result hint. Product/image tools: the count found. capture_order: the
          // OUTCOME — a refusal returns { ok:false } (NOT isError), so without this
          // an order that never persisted would look like a normal ✓ call. Surface
          // the new order id on success, or the refusal reason on failure.
          const r = c.payload?.result as
            | {
                products?: unknown[];
                images?: unknown[];
                ok?: boolean;
                order_id?: string;
                reason?: string;
              }
            | undefined;
          let hint = '';
          if (name === 'capture_order' && r) {
            hint = r.ok
              ? ` → order ${r.order_id ?? '?'} created`
              : ` → NOT created: ${r.reason ?? 'unknown'}`;
          } else if (Array.isArray(r?.products)) {
            hint = ` → ${r.products.length} products`;
          } else if (Array.isArray(r?.images)) {
            hint = ` → ${r.images.length} images`;
          }

          return `${name} ${mark}${args}${hint}`;
        })
        .join(', ');
      this.logger.log(
        `agent turn [${resourceId}] tools(${calls.length}): ${summary} ${meta}`,
      );
    } catch {
      // Observability must never break the customer reply.
    }
  }

  /**
   * Normalizes the provider's usage block to one field set. AI SDK v5 reports
   * inputTokens/outputTokens; some providers report promptTokens/completionTokens.
   * Returns undefined when the result carries no usage at all.
   */
  private normalizeUsage(result: GenerateResult): TurnUsage | undefined {
    const u = result.usage;
    if (!u) return undefined;
    const inputTokens = u.inputTokens ?? u.promptTokens;
    const outputTokens = u.outputTokens ?? u.completionTokens;
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      u.totalTokens === undefined
    ) {
      return undefined;
    }
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(u.cachedInputTokens !== undefined
        ? { cachedInputTokens: u.cachedInputTokens }
        : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(u.totalTokens !== undefined ? { totalTokens: u.totalTokens } : {}),
    };
  }

  /** Field-wise sum of two usage blocks (for the empty-reply retry path). */
  private sumUsage(
    a: TurnUsage | undefined,
    b: TurnUsage | undefined,
  ): TurnUsage | undefined {
    if (!a) return b;
    if (!b) return a;
    const add = (x?: number, y?: number): number | undefined =>
      x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
    const merged: TurnUsage = {};
    const inputTokens = add(a.inputTokens, b.inputTokens);
    const cachedInputTokens = add(a.cachedInputTokens, b.cachedInputTokens);
    const outputTokens = add(a.outputTokens, b.outputTokens);
    const totalTokens = add(a.totalTokens, b.totalTokens);
    if (inputTokens !== undefined) merged.inputTokens = inputTokens;
    if (cachedInputTokens !== undefined)
      merged.cachedInputTokens = cachedInputTokens;
    if (outputTokens !== undefined) merged.outputTokens = outputTokens;
    if (totalTokens !== undefined) merged.totalTokens = totalTokens;
    return merged;
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
              c.payload?.toolName === 'find_similar_by_image' ||
              c.payload?.toolName === 'list_all_products') &&
            !c.payload?.isError,
        )
        .flatMap((c) => {
          const raw = c.payload?.result as
            | {
                products?: Array<{
                  id: string;
                  name: string;
                  price: string;
                  available?: boolean;
                }>;
              }
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
   * Sanitize the per-turn media sink into the list delivered as standalone image
   * messages. The get_product_media tool fills `mediaSink` with the public image
   * URLs the SERVICE selected (the tool's own result is a colour summary with no
   * URLs, so there is no image-attachment path the model can invoke directly).
   *
   * Keeps only http(s) URLs, de-duplicates, and caps the count so one turn can
   * never fan out into a flood of messages. Best-effort: never throws.
   */
  private sanitizeMediaUrls(rawUrls: string[]): string[] {
    const MAX_IMAGES = 8;
    try {
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const url of rawUrls) {
        if (!url || seen.has(url)) continue;
        if (!/^https?:\/\//i.test(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= MAX_IMAGES) return urls;
      }
      return urls;
    } catch {
      return [];
    }
  }

  /**
   * Idempotency key for an inbound turn.
   *
   * WHY: the Meta Messenger platform may re-deliver a webhook event (retry or
   * double-tap). We need a key that collapses re-deliveries within a short
   * window while still letting a genuine new message with the same text through
   * in a later window.
   *
   * RULE:
   *  1. If the provider supplied an explicit message id (Messenger `mid`), use
   *     it as-is. This is the most reliable key and de-dupes perfectly.
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
    const normalizedText = input.text.trim().replace(/\s+/g, ' ').toLowerCase();
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
   * Persist first-touch attribution for a Messenger turn (WS3).
   *
   * Called best-effort (void + catch at the call site) immediately after
   * findOrCreateByPsid — never blocks or errors the reply path.
   *
   * Steps:
   *  1. recordFirstTouchAttribution — atomic single UPDATE WHERE attributed_at
   *     IS NULL.  If this returns undefined the conversation was already
   *     attributed and we stop here (idempotent).
   *  2. SKU product resolution — if adProductId is present, look up the
   *     published product by SKU.  On a match, merge `{ adProduct: { id, name,
   *     priceJod } }` into the conversation state so the agent knows which
   *     advertised product the customer came from.  On no match (unpublished,
   *     wrong SKU, catalog miss) we keep the raw adProductId and do nothing
   *     extra.
   */
  private async persistAttribution(
    conversationId: string,
    referral: NonNullable<IncomingMessage['referral']>,
  ): Promise<void> {
    const updated = await this.conversations.recordFirstTouchAttribution(
      conversationId,
      {
        adId: referral.adId,
        adRef: referral.ref,
        adSource: referral.adSource,
        adProductId: referral.adProductId,
        adContext: referral.adContext,
      },
    );

    // updated is undefined when already attributed — stop here.
    if (!updated) return;

    // SKU-based product resolution (publish gate enforced by the repo query).
    if (referral.adProductId) {
      const product = await this.products.findPublishedBySku(
        referral.adProductId,
      );
      if (product) {
        // Merge into conversation state so the agent picks it up on its next turn.
        await this.conversations.mergeState(conversationId, {
          adProduct: {
            id: product.id,
            name: product.name,
            priceJod: product.priceJod, // string (numeric(10,3) → string end-to-end)
          },
        });
      }
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

  // ---------------------------------------------------------------------------
  // Knowledge pre-fetch (deterministic RAG)
  // ---------------------------------------------------------------------------

  /**
   * Deterministic knowledge pre-fetch. Resolves the product the customer is
   * discussing and returns a formatted Arabic system note with its published FAQ
   * (global entries fill any remaining slots), or undefined when nothing relevant
   * is found.
   *
   * Runs BEFORE generate() so store knowledge is consulted FIRST, independent of
   * whether the LLM chooses to call the get_knowledge tool. Best-effort: any
   * failure returns undefined and the turn proceeds (the tool stays available).
   */
  private async prefetchKnowledgeNote(
    input: IncomingMessage,
    convo: { id: string; state?: unknown },
  ): Promise<string | undefined> {
    // Gating (KNOWLEDGE_PREFETCH_MODE): most turns are search/order moves that
    // never use the FAQ note — injecting it anyway costs ~300-750 tokens each.
    // 'gated' injects only when the text looks like an FAQ question; the
    // get_knowledge tool stays available either way (guardrail rule 1 covers
    // the fallback). 'off' = tool-only; 'always' = legacy behavior.
    if (this.knowledgePrefetchMode === 'off') return undefined;
    if (
      this.knowledgePrefetchMode === 'gated' &&
      !this.isFaqIntent(input.text)
    ) {
      return undefined;
    }
    try {
      const productIds = await this.resolveProductContext(input, convo);

      // Product tier first (no query → the product's full FAQ by priority;
      // getRelevant fills remaining slots from global). Fall back to a global,
      // query-ranked lookup when no product is in context or it has no FAQ.
      let entries =
        productIds.length > 0
          ? await this.knowledge.getRelevant({ productIds })
          : [];
      if (entries.length === 0 && this.isInformationalQuery(input.text)) {
        entries = await this.knowledge.getRelevant({ query: input.text });
      }
      if (entries.length === 0) return undefined;

      return this.formatKnowledgeNote(entries);
    } catch (err) {
      this.logger.warn(
        `Knowledge pre-fetch failed for conversation ${convo.id}: ${String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * FAQ-intent keywords for the 'gated' pre-fetch mode: shipping/delivery,
   * returns/exchange, payment, fabric/care, sizing, policy/warranty — the
   * topics knowledge_entries actually answer. Substring match over the raw
   * text (covers ال-prefixes and suffixed forms); a false positive merely
   * injects a note, a false negative falls back to the get_knowledge tool.
   * Deliberately excludes price words — prices must come from product tools.
   */
  private static readonly FAQ_INTENT_RE =
    /شحن|توصيل|توصل|وصول|ارجاع|إرجاع|ترجيع|رجاع|استبدال|بدل|استرجاع|دفع|كاش|كليك|قماش|خامة|غسيل|عناية|مقاس|قياس|سياس|ضمان|كفال|مضمون|خصم|عرض|كوبون/;

  /**
   * Does this turn look like an FAQ question the knowledge base can answer?
   * Requires a real informational text (not numbers/phone) AND an FAQ keyword.
   */
  private isFaqIntent(text: string | undefined): boolean {
    if (!this.isInformationalQuery(text)) return false;
    return AgentService.FAQ_INTENT_RE.test((text ?? '').trim());
  }

  /**
   * Heuristic gate for the GLOBAL knowledge fallback: skip it for inputs that are
   * clearly not informational questions (empty, or phone/number-only — e.g. the
   * phone she sends during order capture), so we neither query nor inject a
   * knowledge note (and pay its tokens) on those turns. Product-tier knowledge
   * (resolved from context) is unaffected, as is any normal Arabic question.
   */
  private isInformationalQuery(text: string | undefined): boolean {
    const t = (text ?? '').trim();
    if (t.length === 0) return false;
    // Phone / pure-number / punctuation-only inputs carry no question. Includes
    // Arabic-Indic (٠-٩) and Persian (۰-۹) digits, not just ASCII.
    if (/^[\d٠-٩۰-۹\s+()\-ـ]+$/.test(t)) return false;
    return true;
  }

  /**
   * Resolve the product(s) in conversation context for knowledge retrieval, by
   * priority: (1) the photo she sent THIS turn (visual search top match —
   * findSimilarByImage already drops weak matches), (2) the product(s) the agent
   * showed her on a previous turn (state.lastProductIds), (3) the ad-attributed
   * product (state.adProduct.id). Returns [] when none resolve.
   */
  private async resolveProductContext(
    input: IncomingMessage,
    convo: { state?: unknown },
  ): Promise<string[]> {
    if (input.lastImageUrl) {
      const matches = await this.products.findSimilarByImage(
        input.lastImageUrl,
      );
      const topId = matches[0]?.id;
      if (topId) return [topId];
    }

    const state = (convo.state ?? {}) as {
      lastProductIds?: unknown;
      adProduct?: { id?: unknown };
    };

    const last = Array.isArray(state.lastProductIds)
      ? state.lastProductIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (last.length > 0) return last;

    if (typeof state.adProduct?.id === 'string') return [state.adProduct.id];

    return [];
  }

  /**
   * Format pre-fetched knowledge entries into an Arabic system note that tells the
   * agent to answer from store knowledge only, in her own voice, without revealing
   * that she consulted a knowledge base.
   */
  private formatKnowledgeNote(
    entries: Array<{ title: string; content: string }>,
  ): string {
    // Bound the injected note: cap entry count and truncate each answer. The
    // prefetch is a best-effort head-start; get_knowledge stays available for the
    // full text. Keeps this system message from dominating the per-turn context.
    let truncated = false;
    const lines = entries
      .slice(0, this.knowledgeMaxEntries)
      .map((e) => {
        let content = e.content;
        if (content.length > this.knowledgeMaxChars) {
          // Cut on a word boundary so a value/number is never split mid-token,
          // then flag it so the note can point the agent at get_knowledge.
          const cut = content.slice(0, this.knowledgeMaxChars);
          const lastSpace = cut.lastIndexOf(' ');
          content = `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
          truncated = true;
        }
        return `• ${e.title}: ${content}`;
      })
      .join('\n');
    const moreHint = truncated
      ? '\n(الإجابات المنتهية بـ«…» مختصرة — إن احتجتِ التفاصيل الكاملة استخدمي get_knowledge.)'
      : '';
    return (
      'معرفة جاهزة من قاعدة بيانات المتجر — أجيبي من هذه المعلومات حصرًا بأسلوبك ' +
      'الطبيعي، ولا تخترعي غيرها، ولا تخبري الزبونة أنك تبحثين في قاعدة المعرفة:\n' +
      lines +
      moreHint
    );
  }

  /**
   * One-line recap of the products shown last turn (from
   * conversation state.lastProductIds, maintained by collectShownProductIds),
   * with id + name + price so both conversational references ("التانية") and
   * order-flow tool calls (which need the product_id) keep working after
   * ToolCallFilter stripped the original tool payloads from recalled history.
   * Unpublished/missing ids are silently skipped. Best-effort: never throws.
   */
  private async buildShownProductsRecap(convo: {
    state?: unknown;
  }): Promise<string | undefined> {
    try {
      const state = (convo.state ?? {}) as { lastProductIds?: unknown };
      const ids = Array.isArray(state.lastProductIds)
        ? state.lastProductIds
            .filter((x): x is string => typeof x === 'string')
            .slice(0, 8)
        : [];
      if (ids.length === 0) return undefined;

      const settled = await Promise.allSettled(
        ids.map((id) => this.products.getPublishedById(id)),
      );
      const lines: string[] = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled') continue;
        const p = s.value;
        lines.push(
          `${lines.length + 1}) ${p.name} — ${p.priceJod} دينار (product_id: ${p.id})`,
        );
      }
      if (lines.length === 0) return undefined;

      return (
        'آخر موديلات عُرضت على الزبونة (مرجع لإشاراتها مثل «هاي/التانية/اللي ورجيتيني ياها» — استخدمي product_id منها للأدوات):\n' +
        lines.join('\n')
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Product ids the agent surfaced to the customer this turn, most specific first:
   * the product whose photos were sent via get_product_media, then products
   * matched by search_products / find_similar_by_image. Deduped + capped. Persisted
   * to conversation state so the next turn's pre-fetch can resolve "the product in
   * context" without a new photo. Best-effort: a malformed payload yields [].
   */
  private collectShownProductIds(result: GenerateResult): string[] {
    const MAX = 8;
    try {
      const media: string[] = [];
      const matched: string[] = [];
      for (const c of result.toolResults ?? []) {
        if (c.payload?.isError) continue;
        const name = c.payload?.toolName;
        if (name === 'get_product_media') {
          const args = c.payload?.args as { product_id?: unknown } | undefined;
          if (typeof args?.product_id === 'string') media.push(args.product_id);
        } else if (
          name === 'search_products' ||
          name === 'find_similar_by_image'
        ) {
          const raw = c.payload?.result as
            | { products?: Array<{ id?: unknown }> }
            | undefined;
          for (const p of raw?.products ?? []) {
            if (typeof p?.id === 'string') matched.push(p.id);
          }
        }
      }
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const id of [...media, ...matched]) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= MAX) break;
      }
      return ids;
    } catch {
      return [];
    }
  }
}
