/**
 * search_products — البحث في كتالوج العبايات المنشورة.
 *
 * Priority order:
 *  1. If `ad_ref` is provided, surface products linked to that ad first.
 *     If the ad_ref has no mapped products, fall through gracefully (log + continue).
 *  2. Normalize the color dialect term via color_synonyms (exact → fuzzy → raw).
 *  3. If `query` (free text) is given, run fuzzy pg_trgm search; else structured.
 *
 * NOTE: the tool `category` input maps to the product's `occasion` column —
 * there is no separate `category` column on the products table.
 *
 * NOTE: `price` in the output is a STRING (the JOD numeric string from the DB).
 * The project rule is money-as-string end-to-end; never a float.
 */

import { createTool } from '@mastra/core/tools';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const logger = new Logger('SearchProductsTool');

const inputSchema = z.object({
  ad_ref: z
    .string()
    .optional()
    .describe(
      'مرجع الإعلان الذي قدمت منه الزبونة (اختياري) — يُعيد المنتجات المرتبطة بهذا الإعلان أولاً',
    ),
  color: z
    .string()
    .optional()
    .describe('اللون المطلوب بأي لهجة (مثال: نبيتي، عنابي، أزرق غامق)'),
  category: z
    .string()
    .optional()
    .describe('المناسبة أو الفئة (مثال: سهرة، يومي، عمل)'),
  size: z.string().optional().describe('المقاس المطلوب (مثال: M، L، XL)'),
  max_price: z
    .number()
    .optional()
    .describe('الحد الأقصى للسعر بالدينار الأردني'),
  query: z
    .string()
    .optional()
    .describe('نص بحث حر عن المنتج (مثال: عباءة فضفاضة مع حجاب)'),
});

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

export function buildSearchProductsTool(products: ProductsService) {
  return createTool({
    id: 'search_products',
    description:
      'ابحثي في كتالوج العبايات المنشورة حسب اللون والمقاس والمناسبة والسعر ونص البحث الحر. استخدمي هذه الأداة دائماً للحصول على المنتجات — لا تخترعي أسعاراً أو توفراً.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Code-enforced image-over-ad priority (deterministic routing): when the
      // customer sent a photo this turn, the design in the photo wins over the
      // ad she came from — skip the ad_ref fast path entirely so the normal
      // query/structured search runs instead.
      const imageLed = ctx?.requestContext?.get('imageLed') === true;
      const effectiveAdRef = imageLed ? undefined : input.ad_ref;

      // 1. Ad-ref fast path: return products linked to the ad, if any.
      if (effectiveAdRef) {
        const byAd = await products.findByAdRef(effectiveAdRef);
        if (byAd.length > 0) {
          return {
            products: byAd.slice(0, 8).map((p) => ({
              id: p.id,
              name: p.name,
              price: p.priceJod,
              color: p.colorFamily ?? undefined,
              // category maps to occasion on the product row.
              category: p.occasion ?? undefined,
              available: p.stockStatus !== 'out',
            })),
          };
        }
        // No products found for this ad_ref — log and fall through.
        logger.warn('unmapped ad_ref: ' + effectiveAdRef);
      }

      // 2. Normalize the color dialect term.
      const colorFamily = input.color
        ? await products.normalizeColor(input.color)
        : undefined;

      // 3. Build structured filter.
      // tool `category` → product `occasion` (no category column exists).
      const structured = {
        colorFamily,
        size: input.size,
        occasion: input.category,
        priceMax:
          input.max_price != null ? String(input.max_price) : undefined,
      };

      // 4. Search: fuzzy text search if `query` provided, else structured.
      const results = input.query
        ? await products.searchFuzzy(input.query, structured)
        : await products.search(structured);

      return {
        products: results.slice(0, 8).map((p) => ({
          id: p.id,
          name: p.name,
          price: p.priceJod,
          color: p.colorFamily ?? undefined,
          category: p.occasion ?? undefined,
          available: p.stockStatus !== 'out',
        })),
      };
    },
  });
}
