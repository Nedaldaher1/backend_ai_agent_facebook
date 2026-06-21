/**
 * find_similar_by_image — visual catalog search.
 *
 * The customer sends a photo; ProductsService embeds it (Marqo-FashionSigLIP)
 * and returns the visually closest PUBLISHED products via pgvector cosine ANN
 * search. Results are shaped identically to `search_products` so the agent
 * renders them the same way.
 *
 * Never invents products: if no image url is provided, nothing clears the
 * similarity threshold, or the pipeline errors, it returns an empty list and the
 * agent falls back gracefully (ask for a photo / offer text search).
 */

import { createTool } from '@mastra/core/tools';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const logger = new Logger('FindSimilarByImageTool');

// No input fields: the image URL is injected into the request context by
// AgentService (from input.lastImageUrl) before the generate() call.  The agent
// invokes this tool with no arguments when the customer sent a photo.
const inputSchema = z.object({});

const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // price is a string (JOD numeric) — money is a string end-to-end; never float.
      price: z.string(),
      color: z.string().optional(),
      category: z.string().optional(),
      available: z.boolean(),
    }),
  ),
});

export function buildFindSimilarByImageTool(products: ProductsService) {
  return createTool({
    id: 'find_similar_by_image',
    description:
      'ابحثي عن عبايات مشابهة بصرياً للصورة التي أرسلتها الزبونة للتو — الرابط يُؤخذ تلقائياً من السياق، استدعي هذه الأداة بدون أي وسيطات عندما أرسلت الزبونة صورة. لا تخترعي منتجات — إن لم تُرجع الأداة نتائج فاطلبي صورة أوضح أو استخدمي البحث النصي.',
    inputSchema,
    outputSchema,

    execute: async (_input, ctx) => {
      // Read the image URL from the request context (set by AgentService from
      // input.lastImageUrl before the generate() call — never from model input).
      const url = (ctx?.requestContext?.get('lastImageUrl') as string | undefined)?.trim();
      if (!url) {
        // No image in context this turn — empty result; the agent asks for a photo.
        return { products: [] };
      }
      try {
        const matches = await products.findSimilarByImage(url);
        return {
          products: matches.map((p) => ({
            id: p.id,
            name: p.name,
            price: p.priceJod,
            color: p.colorFamily ?? undefined,
            // category maps to occasion on the product row (no category column).
            category: p.occasion ?? undefined,
            available: p.stockStatus !== 'out',
          })),
        };
      } catch (err) {
        // Visual search is best-effort; never throw into the agent's turn.
        logger.warn(
          `find_similar_by_image failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { products: [] };
      }
    },
  });
}
