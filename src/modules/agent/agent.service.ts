import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Agent } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core';
import {
  ProductsService,
  type ProductSearchInput,
} from '@/modules/products/products.service';
import { buildMastra } from './mastra/mastra.factory';

/**
 * The Mastra agent runtime. It composes the other domains strictly through
 * their exported services (never their repositories or the database directly),
 * which keeps every module boundary clean. Only ProductsService is injected
 * today; ConversationsService / OrdersService / KnowledgeService are added here
 * as each domain is implemented (their modules are already imported in
 * agent.module.ts).
 *
 * Lifecycle:
 *  - `onModuleInit` calls `buildMastra`, which constructs the single
 *    `PostgresStore` + `Mastra` instance.  The store's connection pool is
 *    owned by Mastra and stays alive for the process lifetime.
 *  - `ping` is a temporary smoke-test entry point (replaced by the real
 *    ManyChat webhook in a later ticket).
 *
 * Memory scoping:
 *  - `resourceId` = customer Facebook PSID — scopes working memory to the
 *    individual customer across all her threads.
 *  - `threadId`   = ManyChat conversation thread ID — scopes message history
 *    to a single conversation window.
 *
 * TODO (next ticket): register domain tools (search_products etc.) on the agent.
 * TODO (next ticket): wire conversation memory (load/save ConversationsService records).
 * TODO (next ticket): vision pipeline (Haiku attribute extractor).
 * TODO (next ticket): close the PostgresStore pool on shutdown — implement
 *   OnModuleDestroy (await the store's close()) and call
 *   app.enableShutdownHooks() in main.ts so it fires on SIGTERM/redeploy.
 */
@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);

  /**
   * The root Mastra instance — owns the PostgresStore connection pool and the
   * agent registry. Retained for the process lifetime to keep the store alive;
   * a later ticket closes it on shutdown (see the class TODO above).
   */
  private mastra!: Mastra;

  /** The compiled sales agent — call generate() on this. */
  private salesAgent!: Agent;

  constructor(
    private readonly config: ConfigService,
    private readonly products: ProductsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    const connectionString = this.config.getOrThrow<string>('DATABASE_URL');
    const { mastra, salesAgent } = buildMastra(connectionString);
    this.mastra = mastra;
    this.salesAgent = salesAgent;

    // Single-line confirmation that lets ops verify the key config values at a
    // glance without having to trace through the factory code.
    this.logger.log(
      'Mastra ready: schema=mastra, model=claude-sonnet-4-6, workingMemory=resource',
    );
  }

  // ---------------------------------------------------------------------------
  // Cross-domain helpers (sanctioned call style: through exported services only)
  // ---------------------------------------------------------------------------

  /**
   * Example of the only sanctioned cross-domain call style: through the
   * exported service. The real agent will expose this via a Mastra tool.
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
   * Memory options:
   *  - `resource` maps to the customer's Facebook PSID; working-memory entries
   *    are stored at this scope so the agent remembers the customer across all
   *    her threads.
   *  - `thread` maps to the ManyChat conversation thread ID; message history
   *    is scoped per thread.
   *
   * The `memory` option is `AgentMemoryOption` (`{ thread, resource?, options? }`),
   * carried by the v1 execution options (`AgentExecutionOptionsBase`) that
   * `generate()` accepts. We pass the v1 `memory: { resource, thread }` shape —
   * NOT the legacy top-level `resourceId`/`threadId` fields, which belong to the
   * deprecated `generateLegacy` options.
   *
   * @param text      Customer message text.
   * @param resource  Customer PSID (resourceId scope).
   * @param thread    Conversation thread ID (threadId scope).
   */
  async ping(text: string, resource: string, thread: string): Promise<string> {
    const result = await this.salesAgent.generate(text, {
      memory: { resource, thread },
    });
    return result.text;
  }
}
