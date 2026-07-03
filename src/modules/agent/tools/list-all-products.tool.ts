/**
 * list_all_products — أرجِعي كل المنتجات المنشورة في الكتالوج (تصفّح).
 *
 * Use when the customer wants to browse everything ("شو عندكم؟",
 * "ورجيني المنتجات") rather than search by a specific attribute. For attribute
 * search (colour/size/occasion/price/free text) the agent uses search_products.
 *
 * Publish gate: only `is_published = true` products are returned (enforced by
 * ProductsService.listPublished). Results are capped at MAX_LIST so the prompt
 * and the customer reply stay bounded; `total` lets the agent tell her there are
 * more and offer to narrow down.
 *
 * NOTE: `price` is the JOD numeric STRING from the DB — money is a string
 * end-to-end, never a float. `category` maps to the product's `occasion` column
 * (there is no separate category column), mirroring search_products.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

/**
 * Hard cap on products returned in one browse call. Kept modest because this
 * result is stored in the conversation history and re-sent on every subsequent
 * step/turn, and the customer only ever sees the (separately capped) gallery
 * cards — so a large list is wasted prompt tokens. `total` still lets the agent
 * say there are more and offer to narrow down.
 */
const MAX_LIST = 8;

const inputSchema = z.object({});

// Lean model-facing payload (see search-products.tool.ts): id/name/price/
// colors/available only — this list re-enters the prompt on every step.
const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // price is a string (JOD numeric) — money is a string end-to-end; never float.
      price: z.string(),
      // Full set of canonical colour names across the product's image variants.
      colors: z.array(z.string()),
      available: z.boolean(),
    }),
  ),
  // Total published products matching the catalog (may exceed the returned page).
  total: z.number(),
});

export function buildListAllProductsTool(products: ProductsService) {
  return createTool({
    id: 'list_all_products',
    description:
      'Browse the published catalog — use when the customer wants to see everything with no specific criteria ("شو عندكم؟"). For attribute search use search_products. Show only what this returns; `total` may exceed the returned page.',
    inputSchema,
    outputSchema,

    execute: async () => {
      const { items, total } = await products.listPublished(
        {},
        { limit: MAX_LIST },
      );
      const colorsByProduct = await products.getColorNamesByProducts(
        items.map((p) => p.id),
      );
      return {
        products: items.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.priceJod,
          colors: colorsByProduct.get(p.id) ?? [],
          available: p.stockStatus !== 'out',
        })),
        total,
      };
    },
  });
}
