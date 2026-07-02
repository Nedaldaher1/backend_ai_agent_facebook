/**
 * get_order_status — وين صار طلبي؟
 *
 * READ tool. Customer identity (conversationId) is read ONLY from
 * requestContext — never from the tool input. The tool never throws; it
 * returns `{ found: false, orders: [] }` whenever identity is absent or the
 * service finds nothing (including the security case where the requested
 * order_id belongs to a different conversation).
 *
 * All business logic lives in OrdersService.getStatusForConversation:
 *  - Security scoping (foreign orders → empty)
 *  - Arabic status label mapping
 *  - Items summary string construction
 *  - Money stays a string (JOD, numeric(10,3), never float)
 *
 * The tool's only logic is:
 *  1. Read conversationId from requestContext (return early if absent).
 *  2. Call the service with one method call.
 *  3. Map camelCase OrderStatusView keys to snake_case output schema fields.
 *  4. Set the `found` boolean from the list length.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OrdersService } from '@/modules/orders/orders.service';

const inputSchema = z.object({
  order_id: z
    .string()
    .uuid()
    .optional()
    .describe('Specific order UUID; omit to list her recent orders'),
});

const outputSchema = z.object({
  found: z.boolean(),
  orders: z.array(
    z.object({
      order_id: z.string(),
      status: z.string(),
      status_label_ar: z.string(),
      items_summary: z.string(),
      total: z.string(),
      currency: z.string(),
    }),
  ),
});

export function buildGetOrderStatusTool(orders: OrdersService) {
  return createTool({
    id: 'get_order_status',
    description:
      'Get the customer\'s order status ("وين صار طلبي؟"). Her identity comes from context automatically — never ask her for ids.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Identity MUST come from requestContext — never from tool input.
      const conversationId = ctx?.requestContext?.get('conversationId') as
        | string
        | undefined;

      if (!conversationId) {
        // No identity in context: return structured empty result, never throw.
        return { found: false, orders: [] };
      }

      const { orders: views } = await orders.getStatusForConversation(
        conversationId,
        input.order_id,
      );

      // Only logic in the tool: camelCase → snake_case rename + found flag.
      return {
        found: views.length > 0,
        orders: views.map((v) => ({
          order_id: v.orderId,
          status: v.status,
          status_label_ar: v.statusLabelAr,
          items_summary: v.itemsSummary,
          total: v.total,
          currency: v.currency,
        })),
      };
    },
  });
}
