/**
 * get_knowledge — جلب معرفة متجر ماسة من قاعدة البيانات.
 *
 * Returns published knowledge entries (FAQ, policies, shipping, returns, sizing,
 * care instructions, etc.) relevant to the customer's current question.
 * Product-specific entries are surfaced first when `product_ids` is provided.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { KNOWLEDGE_CATEGORIES } from '@/modules/knowledge/entities/knowledge-entry.entity';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';

const inputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Question keywords (e.g. "كيف أرجع المنتج", "كم يستغرق الشحن")'),
  product_ids: z
    .array(z.string())
    .optional()
    .describe(
      'UUIDs of products under discussion — surfaces their entries first',
    ),
  category: z
    .enum(KNOWLEDGE_CATEGORIES)
    .optional()
    .describe('Optional filter (e.g. shipping, returns, faq, sizing)'),
});

const outputSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      category: z.string(),
      product_id: z.string().optional(),
    }),
  ),
});

export function buildGetKnowledgeTool(knowledge: KnowledgeService) {
  return createTool({
    id: 'get_knowledge',
    description:
      "Search the store knowledge base (shipping, delivery, returns/exchange, sizing, payment, policies, fabric care, FAQs). Pass the question's KEYWORDS in `query` (not the full sentence) and `product_ids` when discussing a specific product. Use when the needed info is not already in context.",
    inputSchema,
    outputSchema,

    execute: async (input) => {
      const entries = await knowledge.getRelevant({
        query: input.query,
        productIds: input.product_ids,
        category: input.category,
      });

      return {
        entries: entries.map((e) => ({
          id: e.id,
          title: e.title,
          content: e.content,
          category: e.category,
          ...(e.productId != null ? { product_id: e.productId } : {}),
        })),
      };
    },
  });
}
