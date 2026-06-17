/**
 * capture_order — تسجيل طلب دفع عند الاستلام (COD).
 *
 * WRITE tool. Customer identity (psid, conversationId) comes ONLY from
 * requestContext — never from the tool input. The agent must NEVER invent
 * or accept identity from the conversation text.
 *
 * Design notes:
 *  - `color` is accepted in the item input for the agent's convenience but is
 *    NOT persisted; the order_items table has no color column. product_id
 *    already identifies the exact product variant.
 *  - `payment_method` is not in the output because all orders are COD by
 *    definition and there is no payment_method column on the orders table.
 *  - `total` is computed here via integer milli-JOD arithmetic (never float);
 *    it is NOT stored as a column — the table has no total/currency column.
 *  - `address` is flattened from the structured input into a single text string
 *    (Arabic comma ، separated) to match the single `address text` column.
 *  - The tool validates all items' availability BEFORE creating any order row.
 *    If any item is unavailable, it throws a clear Arabic error and no draft
 *    is created. Partial orders are never written.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import { sumJodLineTotals } from './money.util';

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: z.string().describe('معرّف المنتج (UUID)'),
        size: z.string().optional().describe('المقاس المطلوب'),
        // color is for agent convenience only — not persisted (no color column in order_items).
        color: z
          .string()
          .optional()
          .describe(
            'اللون (للمساعدة فقط، لا يُحفظ — product_id يحدد المنتج بدقة)',
          ),
        quantity: z
          .number()
          .int()
          .min(1)
          .describe('الكمية المطلوبة (1 على الأقل)'),
      }),
    )
    .min(1)
    .describe('قائمة بمنتجات الطلب'),
  customer_name: z.string().optional().describe('اسم الزبونة (اختياري)'),
  phone: z.string().describe('رقم هاتف التوصيل'),
  address: z
    .object({
      city: z.string().describe('المدينة'),
      area: z.string().optional().describe('المنطقة أو الحي'),
      street: z.string().optional().describe('اسم الشارع'),
      details: z.string().optional().describe('تفاصيل إضافية (شقة، عمارة...)'),
    })
    .describe('عنوان التوصيل'),
});

const outputSchema = z.object({
  order_id: z.string(),
  // total is computed via integer milli-JOD arithmetic and returned as a string.
  // NOTE: not stored in the DB — the orders table has no total/currency column.
  total: z.string(),
  currency: z.literal('JOD'),
  status: z.string(),
});

export function buildCaptureOrderTool(
  products: ProductsService,
  orders: OrdersService,
) {
  return createTool({
    id: 'capture_order',
    description:
      'سجّلي طلب دفع عند الاستلام (COD) بعد التأكد من توفر المنتجات. لا تدّعي أن الطلب اكتمل إذا فشلت الأداة.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Identity MUST come from requestContext — never from tool input.
      const conversationId = ctx?.requestContext?.get('conversationId') as
        | string
        | undefined;
      if (!conversationId) {
        throw new Error(
          'لا يمكن تسجيل الطلب: هوية المحادثة غير متوفرة في السياق.',
        );
      }

      // Validate all items before writing anything — no partial orders.
      // checkAvailability also returns the published product, so each product
      // is read only once (price + name come from the same fetch).
      const lineInputs: { priceJod: string; qty: number }[] = [];
      for (const item of input.items) {
        const avail = await products.checkAvailability(
          item.product_id,
          item.size,
        );
        if (!avail.available || !avail.product) {
          const productName = avail.product?.name ?? item.product_id;
          throw new Error(
            `المنتج "${productName}" غير متوفر حالياً${item.size ? ` بمقاس ${item.size}` : ''}. لا يمكن إتمام الطلب.`,
          );
        }
        lineInputs.push({
          priceJod: avail.product.priceJod,
          qty: item.quantity,
        });
      }

      // Compute the total using integer milli-JOD arithmetic (never float).
      const total = sumJodLineTotals(lineInputs);

      // Flatten the structured address into a single text string (Arabic comma).
      const flatAddress = [
        input.address.city,
        input.address.area,
        input.address.street,
        input.address.details,
      ]
        .filter(Boolean)
        .join('، ');

      const { order } = await orders.createCodDraft({
        conversationId,
        customerName: input.customer_name,
        phone: input.phone,
        address: flatAddress,
        items: input.items.map((i) => ({
          productId: i.product_id,
          size: i.size,
          qty: i.quantity,
        })),
      });

      return {
        order_id: order.id,
        total,
        currency: 'JOD' as const,
        status: order.status,
      };
    },
  });
}
