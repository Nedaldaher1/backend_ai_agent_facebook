/**
 * get_knowledge — جلب معرفة متجر ماسة من قاعدة البيانات.
 *
 * Returns published knowledge entries (FAQ, policies, shipping, returns, sizing,
 * care instructions, etc.) relevant to the customer's current question.
 * Product-specific entries are surfaced first when `product_ids` is provided.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  KNOWLEDGE_CATEGORIES,
} from '@/modules/knowledge/entities/knowledge-entry.entity';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';

const inputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'الكلمات الرئيسية أو السؤال الذي تبحثين عنه في قاعدة المعرفة، مثلاً "كيف أرجع المنتج" أو "كم يستغرق الشحن"',
    ),
  product_ids: z
    .array(z.string())
    .optional()
    .describe(
      'معرّفات المنتجات (UUID) التي تناقشها الزبونة حالياً — مرّريها لإظهار المعرفة الخاصة بهذه المنتجات أولاً',
    ),
  category: z
    .enum(KNOWLEDGE_CATEGORIES)
    .optional()
    .describe(
      'تصفية اختيارية حسب نوع المعرفة، مثلاً shipping أو returns أو faq أو sizing',
    ),
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
      'ابحثي في قاعدة معرفة متجر ماسة (الشحن والتوصيل والإرجاع والاستبدال والمقاسات والدفع وسياسات المتجر والعناية بالقماش والأسئلة الشائعة وتفاصيل المنتجات). معرفة المنتج محل النقاش تُزوَّد إليكِ تلقائيًا في السياق؛ استخدمي هذه الأداة للبحث عن معلومة إضافية أو عن منتج مختلف أو موضوع عام لم يَرِد في السياق. مرّري كلمات السؤال المفتاحية في query، و product_ids عند مناقشة منتج معيّن.',
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
