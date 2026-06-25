/**
 * mastra.factory.ts — Single entry point that constructs the Mastra instance
 * and the Masa sales agent.
 *
 * Design decisions:
 *  - ONE `PostgresStore` instance: `schemaName: 'mastra'` keeps all Mastra-
 *    managed tables (`mastra_threads`, `mastra_messages`, …) in a dedicated
 *    Postgres schema, completely isolated from Drizzle's `public` schema.
 *    This prevents name collisions and makes migrations independent.
 *
 *  - ONE `Mastra` instance: owns the store lifecycle, connection pool, and
 *    the agent registry. All injected `Memory` instances inherit this storage
 *    automatically when the agent is registered here.
 *
 *  - `workingMemory` uses `scope: 'resource'` so customer preferences
 *    (name, size, favourite colours, style notes) persist across ALL her
 *    conversations — she only has to tell us once.  No vector store or
 *    embedder is needed for working memory; it is stored as structured JSON
 *    in the thread metadata row.
 *
 *  - Enabling working memory auto-registers a built-in `updateWorkingMemory`
 *    tool on the agent.  This is intentional — do NOT remove it.  The agent
 *    calls the tool to keep the JSON blob up-to-date as it learns about the
 *    customer.
 *
 *  - Domain tools (search_products, list_all_products, check_availability,
 *    get_product_media, recommend_size, get_product_for_order, capture_order,
 *    escalate_to_human, find_similar_by_image, get_order_status) are built via
 *    `buildSalesTools` and registered here. Adding `tools` does NOT remove the
 *    auto-registered `updateWorkingMemory` tool.
 *
 *  - `instructions` is a dynamic async function backed by
 *    AgentBehaviorService.getInstructions() (60s TTL cache). Admin edits to
 *    the agent_behavior table propagate without a redeploy. Mastra v1.42
 *    supports async instructions functions natively.
 *
 * TODO (next ticket): enable semantic recall (requires an embedder + PgVector).
 *
 * NOTE: the vision pipeline (Haiku attribute extractor) is implemented as a
 * deterministic pre-generate step in AgentService (see VisionService), not as a
 * tool here — image presence is known up front, so it is not an LLM decision.
 */

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { PinoLogger } from '@mastra/loggers';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import type { AgentBehaviorService } from '../agent-behavior.service';
import { buildSalesTools } from '../tools/index';

/** Dependencies required to build the Mastra instance. */
export interface BuildMastraDeps {
  /** Full PostgreSQL connection URL (DATABASE_URL env var). */
  connectionString: string;
  /** ProductsService — for catalog read tools. */
  products: ProductsService;
  /** OrdersService — for the capture_order write tool. */
  orders: OrdersService;
  /** ConversationsService — for the escalate_to_human write tool. */
  conversations: ConversationsService;
  /** KnowledgeService — for the get_knowledge read tool. */
  knowledge: KnowledgeService;
  /** SizingService — for the recommend_size read tool. */
  sizing: SizingService;
  /** AgentBehaviorService — compiles dynamic system prompt (60s TTL cache). */
  agentBehavior: AgentBehaviorService;
  /** Sales-agent model id — a Mastra model-router string (AGENT_MODEL_ID env),
   *  e.g. 'openrouter/google/gemini-3.5-flash'. Injected so swapping the model
   *  is a config change, never a code edit. */
  modelId: string;
  /** Mastra framework logger level (from MASTRA_LOG_LEVEL env). Controls Mastra's
   *  own diagnostics (agent steps, tool registration, memory ops); the per-turn
   *  tool-call summary is logged separately by AgentService.logToolCalls. */
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

/**
 * Builds the single Mastra instance together with the sales agent.
 *
 * Call this ONCE at module-init time and hold both the returned `mastra`
 * and `salesAgent` references alive for the lifetime of the process.
 */
export function buildMastra(deps: BuildMastraDeps): {
  mastra: Mastra;
  salesAgent: Agent;
  memory: Memory;
} {
  const { connectionString, products, orders, conversations, knowledge, sizing, agentBehavior, modelId, logLevel } = deps;

  // ------------------------------------------------------------------ storage
  // schemaName: 'mastra' is CRITICAL — isolates Mastra's tables from Drizzle's
  // `public` schema so drizzle-kit migrate never touches them and Mastra's own
  // init never disturbs the product catalog tables.
  const storage = new PostgresStore({
    id: 'masa-mastra-store',
    connectionString,
    schemaName: 'mastra',
  });

  // ------------------------------------------------------------------- tools
  // Build domain tools by closing over the injected services.
  // Registered: search_products, list_all_products, check_availability,
  //   get_product_media, get_knowledge, recommend_size, get_product_for_order,
  //   capture_order, escalate_to_human, find_similar_by_image, get_order_status.
  // `updateWorkingMemory` is auto-registered by Memory and is NOT removed here.
  const tools = buildSalesTools({ products, orders, conversations, knowledge, sizing });

  // ------------------------------------------------------------------ memory
  // Captured as a variable (not inline in the Agent) so AgentService can reach
  // it for the admin "reset conversation" action — clearing resource-scoped
  // working memory and deleting the customer's thread + message history.
  const memory = new Memory({
    // Give Memory its OWN storage handle (the SAME PostgresStore passed to
    // `new Mastra({ storage })` below). Mastra wires storage into an agent's
    // memory only LAZILY — on the first `agent.generate()` of a process. But
    // AgentService.resetConversationMemory() calls memory.updateWorkingMemory /
    // deleteThread DIRECTLY (outside generate), so without an own-storage handle
    // those calls throw "Memory requires a storage provider" until a turn has
    // run, and the admin "reset conversation" silently no-ops. Passing storage
    // here sets hasOwnStorage=true so the reset works regardless of timing.
    storage,
    options: {
      // Keep the last 20 messages in every prompt window.
      lastMessages: 20,

      // No embedder is wired in Phase 1, so semantic recall is disabled.
      // TODO (next ticket): set semanticRecall: { topK: 5 } once PgVector
      //   and an embedder are configured.
      semanticRecall: false,

      workingMemory: {
        enabled: true,

        // 'resource' scope: the JSON blob is keyed by resourceId (= customer
        // PSID) and shared across ALL her conversation threads.  When she
        // comes back a week later on a different thread we still know her size.
        scope: 'resource',

        // Zod schema that constrains what the agent may write into working
        // memory.  The agent calls the auto-registered `updateWorkingMemory`
        // tool with JSON matching this shape.
        schema: z.object({
          /** Customer's first name, if shared. */
          name: z.string().optional(),

          /** Abaya size preference — numeric code from the size chart
           *  (e.g. '1', '2') as returned by the recommend_size tool.
           *  Stored as a permissive string to accept both legacy letter
           *  values and current numeric codes without schema rejection. */
          size: z.string().optional(),

          /** Colour preferences expressed in any dialect the customer used
           *  (stored raw; normalisation happens in the search tool). */
          preferred_colors: z.array(z.string()).default([]),

          /** Free-form style notes ("تحب العبايات الكلاسيكية", etc.). */
          style_notes: z.string().optional(),

          /** The ad reference that brought this customer to the conversation
           *  (set from the Messenger referral data on first touch). */
          last_interested_ad_ref: z.string().optional(),
        }),
      },
    },
  });

  // ------------------------------------------------------------- sales agent
  const salesAgent = new Agent({
    id: 'sales-agent',
    name: 'Masa Sales Agent',

    // DYNAMIC instructions: resolved per-generate from the cached
    // AgentBehaviorService.getInstructions() (60s TTL) so admin edits to the
    // agent_behavior row propagate without a redeploy. Mastra v1.42 supports an
    // async instructions function. Falls back to a safe default when empty.
    instructions: async () => agentBehavior.getInstructions(),

    // Mastra's model router. An 'openrouter/<provider>/<model>' id routes the
    // call through OpenRouter, which the router authenticates with
    // OPENROUTER_API_KEY (see @mastra/core provider-registry). The id is
    // injected (AGENT_MODEL_ID), not hard-coded, so the model is swappable
    // without a code edit.
    model: modelId,

    tools,

    memory,
  });

  // ------------------------------------------------------------ mastra root
  // Registering the agent here lets Mastra wire `storage` into the agent's
  // memory for the generate() path. That wiring is LAZY (first generate()), so
  // we ALSO pass `storage` to Memory directly above — the same instance — so
  // the standalone reset path works before any turn. hasOwnStorage=true makes
  // Mastra's addMemory skip re-setting, so there is no double-wiring.
  //
  // logger: routes Mastra's internal diagnostics (agent steps, tool registration,
  // memory ops) through Pino at MASTRA_LOG_LEVEL. At 'debug' it surfaces tool-
  // related traces; clean per-turn tool-call summaries are logged separately by
  // AgentService.logToolCalls. PinoLogger emits JSON — pipe the dev server
  // through `bunx pino-pretty` for readable terminal output.
  const logger = new PinoLogger({ name: 'MasaAgent', level: logLevel });
  const mastra = new Mastra({ agents: { salesAgent }, storage, logger });

  return { mastra, salesAgent, memory };
}
