/**
 * capture_order — تسجيل طلب دفع عند الاستلام (COD).
 *
 * WRITE tool. Customer identity (conversationId) and the order `source` come
 * ONLY from requestContext — never from the tool input. The agent must NEVER
 * invent identity, nor supply prices/totals.
 *
 * Design notes:
 *  - The tool is thin: it reads identity + channel from requestContext, maps the
 *    channel to the order `source`, and delegates ALL business logic to
 *    OrdersService.captureCodOrder (per-item catalog resolution, size validation,
 *    price snapshots, delivery fee, totals, atomic persistence).
 *  - The agent picks each item by `storage_key` (the chosen product image), which
 *    identifies the exact model + its color via product_image_colors. No color or
 *    price is accepted from the agent — both are resolved/snapshotted server-side.
 *  - All money is returned as JOD strings (numeric, never float). On ANY
 *    validation failure the service throws a clear Arabic error and NO order is
 *    written — partial orders are never created.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OrdersService } from '@/modules/orders/orders.service';

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: z.string().describe('معرّف المنتج (UUID)'),
        storage_key: z
          .string()
          .describe('مفتاح صورة المنتج المختارة (يحدد الموديل ولونه)'),
        size: z
          .string()
          .optional()
          .describe('مقاس هذا المنتج (اختياري — يُستخدم المقاس الموحّد إن لم يُذكر)'),
        quantity: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe('الكمية (الافتراضي 1)'),
      }),
    )
    .min(1)
    .describe('قائمة المنتجات في الطلب (منتج واحد على الأقل)'),
  phone: z
    .string()
    .describe('رقم موبايل أردني (07XXXXXXXX أو +9627XXXXXXXX)'),
  address: z
    .string()
    .min(1)
    .describe('عنوان التوصيل كاملاً (المحافظة/المدينة، المنطقة، الشارع، البناية...)'),
  unified_size: z
    .string()
    .optional()
    .describe('مقاس موحّد لكل منتج لم يُحدد له مقاس (اختياري)'),
});

const outputSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  order_id: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string(),
        product_name: z.string(),
        color_name: z.string().optional(),
        size: z.string().optional(),
        quantity: z.number().int(),
        unit_price: z.string(),
        line_total: z.string(),
      }),
    )
    .optional(),
  subtotal: z.string().optional(),
  delivery_fee: z.string().optional(),
  total: z.string().optional(),
  currency: z.string().optional(),
});

export function buildCaptureOrderTool(orders: OrdersService) {
  return createTool({
    id: 'capture_order',
    description:
      'سجّلي طلب دفع عند الاستلام (COD) بعد التأكد من اختيار المنتجات والمقاسات والعنوان. الأسعار والمجاميع تُحسب تلقائياً من الكتالوج — لا تذكري سعراً من عندك. لا تدّعي أن الطلب اكتمل إذا فشلت الأداة.',
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

      // `source` is derived from the inbound channel (server-set), not the LLM.
      // Today the temp endpoint is messenger; whatsapp is honored when present.
      const channel = ctx?.requestContext?.get('channel') as string | undefined;
      const source = channel === 'whatsapp' ? 'whatsapp' : 'messenger';

      const result = await orders.captureCodOrderSafe({
        conversationId,
        source,
        phone: input.phone,
        address: input.address,
        unifiedSize: input.unified_size,
        items: input.items.map((i) => ({
          productId: i.product_id,
          storageKey: i.storage_key,
          size: i.size,
          // `.default(1)` is applied by zod on the parsed input; default again
          // here so the qty is concrete (number) for the service contract.
          qty: i.quantity ?? 1,
        })),
      });

      // Validation failure: return the reason so the agent can phrase a reply.
      // NEVER report success or fabricate order fields when ok is false.
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }

      // Success: map confirmation to snake_case agent-facing output.
      const { confirmation } = result;
      return {
        ok: true,
        order_id: confirmation.orderId,
        status: confirmation.status,
        source: confirmation.source,
        phone: confirmation.phone,
        address: confirmation.address,
        items: confirmation.lines.map((l) => ({
          product_id: l.productId,
          product_name: l.productName,
          color_name: l.colorName ?? undefined,
          size: l.size ?? undefined,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          line_total: l.lineTotal,
        })),
        subtotal: confirmation.subtotal,
        delivery_fee: confirmation.deliveryFee,
        total: confirmation.total,
        currency: confirmation.currency,
      };
    },
  });
}
