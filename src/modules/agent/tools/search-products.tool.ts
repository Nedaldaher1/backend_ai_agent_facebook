/**
 * search_products — البحث في كتالوج الملابس المنشورة.
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
      'Ad ref the customer came from — returns its linked products first',
    ),
  color: z
    .string()
    .optional()
    .describe('Requested color in any dialect (e.g. نبيتي، عنابي، أزرق غامق)'),
  category: z
    .string()
    .optional()
    .describe('Occasion/category (e.g. سهرة، يومي، عمل)'),
  size: z.string().optional().describe('Requested size (e.g. M, L, 2)'),
  max_price: z.number().optional().describe('Max price in JOD'),
  query: z
    .string()
    .optional()
    .describe('Free-text search (e.g. عباءة فضفاضة مع حجاب)'),
});

// Lean model-facing payload: id/name/price/colors/available only. The primary
// colour family and occasion were dropped — `colors` already contains the
// family, and these results re-enter the prompt on every step, so every field
// is paid for many times.
const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // price is a string (JOD numeric) — money is a string end-to-end; never float.
      price: z.string(),
      // FULL set of canonical colour names across the product's image variants.
      colors: z.array(z.string()),
      available: z.boolean(),
    }),
  ),
});

export function buildSearchProductsTool(products: ProductsService) {
  return createTool({
    id: 'search_products',
    description:
      'Search the published clothing catalog by color, size, occasion, price, or free text. Always use this (never invent products, prices, or availability).',
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
          const top = byAd.slice(0, 8);
          const colorsByProduct = await products.getColorNamesByProducts(
            top.map((p) => p.id),
          );
          return {
            products: top.map((p) => ({
              id: p.id,
              name: p.name,
              price: p.priceJod,
              colors: colorsByProduct.get(p.id) ?? [],
              available: p.stockStatus !== 'out',
            })),
          };
        }
        // No products found for this ad_ref — log and fall through.
        logger.warn('unmapped ad_ref: ' + effectiveAdRef);
      }

      // 2. Resolve the color filter. Prefer the agent-supplied color — passed
      // RAW: the service fans a dialect term out to EVERY canonical family it
      // can mean ("اخضر" → green + light_green). Normalizing to a single family
      // here made the agent deny variant colors it actually stocked. On an
      // image-led turn with no agent color, fall back to the vision-extracted
      // color family seeded into the request context (already canonical).
      const color = input.color;
      let colorFamily: string | undefined;
      if (!color && imageLed) {
        const seeded = ctx?.requestContext?.get<
          string,
          { colorFamily?: string } | undefined
        >('visionAttributes');
        colorFamily = seeded?.colorFamily;
      }

      // 3. Build structured filter.
      // tool `category` → product `occasion` (no category column exists).
      const structured = {
        color,
        colorFamily,
        size: input.size,
        occasion: input.category,
        priceMax: input.max_price != null ? String(input.max_price) : undefined,
      };

      // 4. Search: fuzzy text search if `query` provided, else structured.
      const results = input.query
        ? await products.searchFuzzy(input.query, structured)
        : await products.search(structured);

      const top = results.slice(0, 8);
      const colorsByProduct = await products.getColorNamesByProducts(
        top.map((p) => p.id),
      );
      return {
        products: top.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.priceJod,
          colors: colorsByProduct.get(p.id) ?? [],
          available: p.stockStatus !== 'out',
        })),
      };
    },
  });
}
