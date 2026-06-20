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
import { buildMastra } from './mastra/mastra.factory';

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
}

/**
 * Agent reply returned to the controller and eventually to ManyChat.
 *
 * `price` is a STRING (JOD notation) to honour the money-as-string rule
 * (CLAUDE.md §3 — never use float for prices).  Phase 4 formats it for the
 * Dynamic Block card.
 */
export interface AgentReply {
  reply: string;
  products?: Array<{ id: string; name: string; price: string }>;
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
    };
  }>;
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
 *    `threadId`, and (when present) `adRef`.
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
      agentBehavior: this.agentBehavior,
    });
    this.mastra = mastra;
    this.salesAgent = salesAgent;

    this.logger.log(
      'Mastra ready: schema=mastra, model=claude-sonnet-4-6, workingMemory=resource, tools=7, instructions=dynamic',
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
   *  7. Extracts any search_products results for the reply card (best-effort).
   */
  async handleMessage(input: IncomingMessage): Promise<AgentReply> {
    const resourceId = input.contactId;
    const threadId = `thread:${input.contactId}`;

    const convo = await this.conversations.findOrCreateByPsid(resourceId, {
      threadId,
      adRef: input.adRef,
    });

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

    // Best-effort name seed: surfaces the FB profile name so the agent persists
    // it to working memory via its guardrail; the "only if working-memory name
    // is empty" refinement is deferred (the model won't overwrite a known name).
    // Cast to the expected ModelMessage array — role: 'system' is valid per the
    // SystemModelMessage type in @mastra/core's internal AI SDK types.
    const context = input.name
      ? ([{ role: 'system', content: `اسم الزبونة من فيسبوك: ${input.name}` }] as Array<{ role: 'system'; content: string }>)
      : undefined;

    // TODO (vision phase): download lastImageUrl + ad_ref-first + Claude Vision Haiku enum extraction

    // Persist the business record BEFORE generating — public-schema rows for the
    // admin panel + eval (diagram node T), NOT a duplicate of Mastra's LLM context
    // store. Business-log writes are best-effort (see logTurn): a logging failure
    // must never deny the customer her reply.
    await this.logTurn({
      conversationId: convo.id,
      role: 'customer',
      content: input.text,
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

    // Persist the agent reply — same best-effort business-log rationale.
    await this.logTurn({
      conversationId: convo.id,
      role: 'agent',
      content: result.text,
    });

    return { reply: result.text, products: this.extractProducts(result) };
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
   * Extracts deduplicated product cards from search_products tool results.
   *
   * Defensive + best-effort: the whole body is wrapped in try/catch so a
   * malformed toolResults payload NEVER breaks the reply to the customer.
   * Returns `undefined` (field omitted) when there are no products to surface.
   */
  private extractProducts(result: GenerateResult): AgentReply['products'] {
    try {
      const chunks = result.toolResults ?? [];

      const products = chunks
        .filter(
          (c) =>
            c.payload?.toolName === 'search_products' && !c.payload?.isError,
        )
        .flatMap((c) => {
          const raw = c.payload?.result as
            | { products?: Array<{ id: string; name: string; price: string; available?: boolean }> }
            | undefined;
          return raw?.products ?? [];
        });

      // Dedupe by id (first occurrence wins), cap at 8 (carousel limit).
      const seen = new Set<string>();
      const deduped: Array<{ id: string; name: string; price: string }> = [];
      for (const p of products) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        deduped.push({ id: p.id, name: p.name, price: p.price });
        if (deduped.length === 8) break;
      }

      return deduped.length > 0 ? deduped : undefined;
    } catch {
      return undefined;
    }
  }
}
