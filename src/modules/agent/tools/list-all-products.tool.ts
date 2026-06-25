/**
 * list_all_products — أرجِعي كل العبايات المنشورة في الكتالوج (تصفّح).
 *
 * Use when the customer wants to browse everything ("شو عندكم؟",
 * "ورجيني العبايات") rather than search by a specific attribute. For attribute
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

/** Hard cap on products returned in one browse call. */
const MAX_LIST = 30;

const inputSchema = z.object({});

const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // price is a string (JOD numeric) — money is a string end-to-end; never float.
      price: z.string(),
      // `color` is the primary colour family; `colors` is the full set of
      // canonical colour names across the product's image variants.
      color: z.string().optional(),
      colors: z.array(z.string()),
      category: z.string().optional(),
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
      'أرجِعي كل العبايات المنشورة في الكتالوج. استخدميها لما تطلب الزبونة تشوف كل المنتجات أو تتصفّح بدون طلب محدّد (مثل: "شو عندكم؟"، "ورجيني العبايات"). للبحث بمواصفات معينة (لون/مقاس/مناسبة/سعر) استخدمي search_products. لا تخترعي منتجات أو أسعاراً — اعرضي فقط ما تُرجِعه هذه الأداة.',
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
          color: p.colorFamily ?? undefined,
          colors: colorsByProduct.get(p.id) ?? [],
          // category maps to occasion on the product row.
          category: p.occasion ?? undefined,
          available: p.stockStatus !== 'out',
        })),
        total,
      };
    },
  });
}
