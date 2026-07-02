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
 *  - The agent picks each item's colour by NAME (`color`) — the primary selector.
 *    The service resolves it to the matching variant image via product_image_colors
 *    and snapshots the canonical colour. `storage_key` is an optional fallback
 *    (admin / image-led). Price is never accepted from the agent — snapshotted
 *    server-side. An unresolvable colour is refused (no primary-colour fallback).
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
        product_id: z.string().describe('Product UUID'),
        color: z
          .string()
          .optional()
          .describe(
            'The color the customer chose for THIS item, exactly as she said it (e.g. "أزرق غامق") — the primary selector; the system matches it to the color\'s image. Required for multi-color models.',
          ),
        storage_key: z
          .string()
          .optional()
          .describe(
            'Image key (advanced fallback only — pass `color` on the normal path).',
          ),
        size: z
          .string()
          .optional()
          .describe("This item's size (falls back to unified_size)"),
        quantity: z.number().int().min(1).default(1).describe('Qty, default 1'),
      }),
    )
    .min(1)
    .describe('Order items (at least one)'),
  phone: z.string().describe('Jordanian mobile (07XXXXXXXX or +9627XXXXXXXX)'),
  address: z
    .string()
    .min(1)
    .describe(
      'Full delivery address (governorate/city, area, street, building…)',
    ),
  unified_size: z
    .string()
    .optional()
    .describe('Size applied to items without their own (optional)'),
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
      "Register a cash-on-delivery order AFTER items, colors, sizes, and address are confirmed. Pass each item's color exactly as the customer said it. Prices/fees/totals are computed server-side — never state your own. If it returns ok:false the order was NOT created: relay the reason (e.g. offer the available colors), never claim success.",
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Identity MUST come from requestContext — never from tool input.
      const conversationId = ctx?.requestContext?.get('conversationId');
      if (!conversationId) {
        throw new Error(
          'لا يمكن تسجيل الطلب: هوية المحادثة غير متوفرة في السياق.',
        );
      }

      // `source` is derived from the inbound channel (server-set), not the LLM.
      // Today the temp endpoint is messenger; whatsapp is honored when present.
      const channel = ctx?.requestContext?.get('channel');
      const source = channel === 'whatsapp' ? 'whatsapp' : 'messenger';

      const result = await orders.captureCodOrderSafe({
        conversationId,
        source,
        phone: input.phone,
        address: input.address,
        unifiedSize: input.unified_size,
        items: input.items.map((i) => ({
          productId: i.product_id,
          color: i.color,
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
