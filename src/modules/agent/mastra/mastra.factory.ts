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
 * TODO (next ticket): register domain tools (search_products, check_availability,
 *   get_product_media, capture_order, escalate_to_human, find_similar_by_image).
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

/**
 * Builds the single Mastra instance together with the sales agent.
 *
 * Call this ONCE at module-init time and hold both the returned `mastra`
 * and `salesAgent` references alive for the lifetime of the process.
 *
 * @param connectionString  Full PostgreSQL URL (read from DATABASE_URL env var).
 */
export function buildMastra(connectionString: string): {
  mastra: Mastra;
  salesAgent: Agent;
} {
  // ------------------------------------------------------------------ storage
  // schemaName: 'mastra' is CRITICAL — isolates Mastra's tables from Drizzle's
  // `public` schema so drizzle-kit migrate never touches them and Mastra's own
  // init never disturbs the product catalog tables.
  const storage = new PostgresStore({
    id: 'masa-mastra-store',
    connectionString,
    schemaName: 'mastra',
  });

  // ------------------------------------------------------------- sales agent
  const salesAgent = new Agent({
    id: 'sales-agent',
    name: 'Masa Sales Agent',

    instructions: [
      // Brand voice + language
      'أنتِ مساعدة مبيعات لمتجر عبايات "ماسة" في الأردن. ردّي باللهجة الأردنية وباختصار.',

      // Working-memory duty: capture customer profile whenever new info appears
      'عندما تذكر الزبونة اسمها أو مقاسها أو ألوانها المفضّلة أو ستايلها، ' +
        'احفظيها في الـ working memory مباشرةً باستخدام الأداة المتاحة.',

      // Guardrail: never fabricate product data
      'لا تختلقي أسعاراً أو توفّراً — هذه ستأتي لاحقاً من قاعدة البيانات.',
    ].join('\n'),

    // Mastra's model router — reads ANTHROPIC_API_KEY from the environment
    // automatically.  Do NOT import @ai-sdk/anthropic directly here.
    model: 'anthropic/claude-sonnet-4-6',

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

            /** Abaya size preference. */
            size: z.enum(['S', 'M', 'L', 'XL', 'XXL']).optional(),

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

    // TODO (next ticket): register domain tools here once they are built:
    //   tools: { search_products, check_availability, get_product_media,
    //            capture_order, escalate_to_human, find_similar_by_image }
  });

  // ------------------------------------------------------------ mastra root
  // Registering the agent under the `salesAgent` key here automatically
  // injects this `storage` instance into Memory, so we do NOT pass the store
  // to Memory separately.
  const mastra = new Mastra({ agents: { salesAgent }, storage });

  return { mastra, salesAgent };
}
