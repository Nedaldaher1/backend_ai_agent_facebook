/**
 * check_availability — تحقق من توفر منتج معين.
 *
 * Reads the published product via ProductsService.checkAvailability.
 * Only published products can be "available" — unpublished are reported as
 * unavailable. Optionally checks a specific size.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const inputSchema = z.object({
  product_id: z
    .string()
    .describe('معرّف المنتج (UUID) المراد التحقق من توفره'),
  size: z
    .string()
    .optional()
    .describe('المقاس المطلوب (اختياري) — إذا ذُكر يتحقق من توفر هذا المقاس تحديداً'),
});

const outputSchema = z.object({
  available: z.boolean(),
  in_stock_sizes: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export function buildCheckAvailabilityTool(products: ProductsService) {
  return createTool({
    id: 'check_availability',
    description:
      'تحققي من توفر عباءة معينة وما هي المقاسات المتاحة. لا تُخبري الزبونة بالتوفر إلا بعد استخدام هذه الأداة.',
    inputSchema,
    outputSchema,

    execute: async (input) => {
      const result = await products.checkAvailability(
        input.product_id,
        input.size,
      );
      return {
        available: result.available,
        in_stock_sizes: result.inStockSizes,
        note: result.note,
      };
    },
  });
}
