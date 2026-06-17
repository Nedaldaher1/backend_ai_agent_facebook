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
import { AgentBehaviorService } from './agent-behavior.service';
import { buildMastra } from './mastra/mastra.factory';

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
 *  - `ping` is a temporary smoke-test entry point (replaced by the real
 *    ManyChat webhook in a later ticket).
 *
 * Memory scoping:
 *  - `resourceId` = customer Facebook PSID — scopes working memory to the
 *    individual customer across all her threads.
 *  - `threadId`   = ManyChat conversation thread ID — scopes message history
 *    to a single conversation window.
 *
 * RequestContext:
 *  - Populated before every generate() call with `psid` and `conversationId`.
 *  - Write tools (capture_order, escalate_to_human) read identity from here —
 *    NEVER from their tool input schema.
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
      agentBehavior: this.agentBehavior,
    });
    this.mastra = mastra;
    this.salesAgent = salesAgent;

    this.logger.log(
      'Mastra ready: schema=mastra, model=claude-sonnet-4-6, workingMemory=resource, tools=6, instructions=dynamic',
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
   * Sends `text` to the Masa sales agent and returns the text reply.
   *
   * Before generating:
   *  1. Ensures a Conversation row exists for the PSID (findOrCreateByPsid).
   *  2. Builds a RequestContext carrying `psid` and `conversationId` so that
   *     write tools can read the customer's identity without it being in the
   *     tool input schema (security boundary).
   *
   * @param text      Customer message text.
   * @param resource  Customer PSID (resourceId scope for memory).
   * @param thread    Conversation thread ID (threadId scope for message history).
   */
  async ping(text: string, resource: string, thread: string): Promise<string> {
    // Ensure a conversation record exists for this PSID.
    const convo = await this.conversations.findOrCreateByPsid(resource, {
      threadId: thread,
    });

    // Build the RequestContext that write tools read for identity.
    const requestContext = new RequestContext();
    requestContext.set('psid', resource);
    requestContext.set('conversationId', convo.id);

    const result = await this.salesAgent.generate(text, {
      memory: { resource, thread },
      requestContext,
    });
    return result.text;
  }
}
