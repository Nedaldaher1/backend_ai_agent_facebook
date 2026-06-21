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
 *  - Domain tools (search_products, check_availability, get_product_media,
 *    recommend_size, capture_order, escalate_to_human, find_similar_by_image)
 *    are built via `buildSalesTools` and registered here. Adding `tools` does
 *    NOT remove the auto-registered `updateWorkingMemory` tool.
 *
 *  - `instructions` is a dynamic async function backed by
 *    AgentBehaviorService.getInstructions() (60s TTL cache). Admin edits to
 *    the agent_behavior table propagate without a redeploy. Mastra v1.42
 *    supports async instructions functions natively.
 *
 * TODO (next ticket): enable semantic recall (requires an embedder + PgVector).
 *
 * TODO (next ticket): wire the vision pipeline (Haiku-powered attribute extractor).
 */

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
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
} {
  const { connectionString, products, orders, conversations, knowledge, sizing, agentBehavior } = deps;

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
  // Registered: search_products, check_availability, get_product_media,
  //   get_knowledge, recommend_size, capture_order, escalate_to_human,
  //   find_similar_by_image.
  // `updateWorkingMemory` is auto-registered by Memory and is NOT removed here.
  const tools = buildSalesTools({ products, orders, conversations, knowledge, sizing });

  // ------------------------------------------------------------- sales agent
  const salesAgent = new Agent({
    id: 'sales-agent',
    name: 'Masa Sales Agent',

    // DYNAMIC instructions: resolved per-generate from the cached
    // AgentBehaviorService.getInstructions() (60s TTL) so admin edits to the
    // agent_behavior row propagate without a redeploy. Mastra v1.42 supports an
    // async instructions function. Falls back to a safe default when empty.
    instructions: async () => agentBehavior.getInstructions(),

    // Mastra's model router — reads ANTHROPIC_API_KEY from the environment
    // automatically.  Do NOT import @ai-sdk/anthropic directly here.
    model: 'anthropic/claude-sonnet-4-6',

    tools,

    memory: new Memory({
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
             *  (populated by the ManyChat webhook in a later phase). */
            last_interested_ad_ref: z.string().optional(),
          }),
        },
      },
    }),
  });

  // ------------------------------------------------------------ mastra root
  // Registering the agent under the `salesAgent` key here automatically
  // injects this `storage` instance into Memory, so we do NOT pass the store
  // to Memory separately.
  const mastra = new Mastra({ agents: { salesAgent }, storage });

  return { mastra, salesAgent };
}
