/**
 * recommend_size — أوصي بمقاس القطعة بناءً على وزن الزبونة ومقاسات المنتج نفسه.
 *
 * Sizes are per-product now, so this tool takes the product_id whose sizes to
 * use (from an earlier search/list result), fetches that product, and asks
 * SizingService to pick a size from ITS own size list. Letter-only products
 * (no weight bands) come back with the available labels for the customer to
 * choose; an out-of-range weight comes back with needs_human=true to escalate.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';
import type { SizingService } from '@/modules/sizing/sizing.service';

const inputSchema = z.object({
  product_id: z
    .string()
    .describe('Id of the product whose sizes to use (from a search result)'),
  weight_kg: z.number().positive().describe("Customer's weight in kg"),
  height_cm: z
    .number()
    .positive()
    .optional()
    .describe("Customer's height in cm (optional)"),
});

const outputSchema = z.object({
  size: z.string().nullable(),
  note: z.string().optional(),
  needs_human: z.boolean().optional(),
});

export function buildRecommendSizeTool(
  products: ProductsService,
  sizing: SizingService,
) {
  return createTool({
    id: 'recommend_size',
    description:
      "Recommend a clothing size from the customer's weight (height optional) using the given product's own sizes. If it returns needs_human=true, hand off via escalate_to_human.",
    inputSchema,
    outputSchema,

    execute: async (input) => {
      // Only size published products; a missing/unpublished id → soft escalate.
      let sizes: Awaited<ReturnType<typeof products.getById>>['sizes'];
      try {
        const product = await products.getById(input.product_id, {
          publishedOnly: true,
        });
        sizes = product.sizes;
      } catch {
        return {
          size: null,
          needs_human: true,
          note: 'ما قدرت ألاقي هذا المنتج لأحدّد مقاسه، رح يساعدك فريقنا.',
        };
      }

      const r = sizing.recommendSizeForProduct(
        sizes,
        input.weight_kg,
        input.height_cm,
      );
      return {
        size: r.size,
        note: r.note,
        needs_human: r.needsHuman,
      };
    },
  });
}
