/**
 * get_product_for_order — حلّل منتجًا مختارًا إلى مفتاح الطلب والمقاسات المتاحة.
 *
 * يحوّل product_id إلى storage_key (مفتاح الصورة الأولى) والمقاسات المتاحة
 * حتى يتمكن capture_order من تسجيل الطلب. إذا كانت النتيجة found:false فالمنتج
 * غير قابل للطلب (غير منشور أو بلا صورة) ويجب على الوكيل اختيار منتج آخر.
 *
 * This tool is THIN: all logic (publish gate, image gate, availability check)
 * lives in ProductsService.resolveForOrder. This layer only renames fields
 * from camelCase to snake_case for the agent's tool schema.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const inputSchema = z.object({
  product_id: z
    .string()
    .uuid()
    .describe('UUID of the product the customer chose'),
});

const outputSchema = z.object({
  found: z.boolean(),
  product: z
    .object({
      product_id: z.string(),
      storage_key: z.string(),
      name: z.string(),
      price: z.string(),
      color: z.string().optional(),
      available: z.boolean(),
      available_sizes: z.array(z.string()),
    })
    .optional(),
});

export function buildGetProductForOrderTool(products: ProductsService) {
  return createTool({
    id: 'get_product_for_order',
    description:
      'Resolve the chosen product for ordering (storage_key + available sizes) ahead of capture_order. found:false means it is not orderable (unpublished or no image) — pick another product.',
    inputSchema,
    outputSchema,

    execute: async (input) => {
      const r = await products.resolveForOrder(input.product_id);
      if (!r.found || !('product' in r)) return { found: false };
      const p = r.product;
      return {
        found: true,
        product: {
          product_id: p.productId,
          storage_key: p.storageKey,
          name: p.name,
          price: p.priceJod,
          color: p.colorFamily ?? undefined,
          available: p.available,
          available_sizes: p.availableSizes,
        },
      };
    },
  });
}
