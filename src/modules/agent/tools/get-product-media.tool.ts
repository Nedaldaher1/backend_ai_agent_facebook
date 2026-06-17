/**
 * get_product_media — جلب صور المنتج.
 *
 * Returns the image URLs for a published product. Returns an empty media array
 * for unpublished or missing products — the agent should not reveal those.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const inputSchema = z.object({
  product_id: z
    .string()
    .describe('معرّف المنتج (UUID) المراد جلب صوره'),
});

const outputSchema = z.object({
  media: z.array(
    z.object({
      url: z.string(),
      type: z.string(),
    }),
  ),
});

export function buildGetProductMediaTool(products: ProductsService) {
  return createTool({
    id: 'get_product_media',
    description:
      'جلبي صور منتج معين لإرسالها للزبونة. استخدمي هذه الأداة قبل مشاركة أي صورة.',
    inputSchema,
    outputSchema,

    execute: async (input) => {
      const media = await products.getMedia(input.product_id);
      return { media };
    },
  });
}
