import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  ORDER_SOURCES,
  ORDER_STATUSES,
  selectOrderSchema,
} from '../entities/order.entity';
import { selectOrderItemSchema } from '../entities/order-item.entity';

/**
 * OpenAPI DTOs for the admin orders surface. Validation stays with the zod
 * schemas; these classes only document request/response shapes in the Scalar
 * docs. The response re-types the `createdAt` timestamp from `z.date()` to an
 * ISO-8601 string (see color.dto.ts for the rationale). Money columns are
 * already strings (numeric(10,3)) end-to-end, so they need no re-typing.
 */
export const orderResponseSchema = selectOrderSchema.extend({
  createdAt: z.iso.datetime(),
});
export class OrderDto extends createZodDto(orderResponseSchema) {}

/**
 * The GET /admin/orders/:id response: the order header plus its line items
 * (order_items has no timestamps, so its select schema is used as-is).
 */
export const orderWithItemsResponseSchema = orderResponseSchema.extend({
  items: z.array(selectOrderItemSchema),
});
export class OrderWithItemsDto extends createZodDto(
  orderWithItemsResponseSchema,
) {}

/**
 * Body for PATCH /admin/orders/:id/status. `status` must be one of the COD
 * lifecycle states; `.strict()` rejects any other key. The service revalidates
 * the value, so this is the first of two guards against an out-of-enum status.
 */
export const updateOrderStatusSchema = z
  .object({ status: z.enum(ORDER_STATUSES) })
  .strict();
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export class UpdateOrderStatusDto extends createZodDto(
  updateOrderStatusSchema,
) {}

/**
 * Body for POST /admin/orders. Mirrors the agent's capture_order input so the
 * route can reuse OrdersService.captureCodOrder: the server resolves
 * price/colour/size from the catalog and derives every total, so NO money is
 * accepted here (and `.strict()` rejects a smuggled `unitPrice`/`total`). The
 * service re-validates everything, throwing an Arabic OrderCaptureError → 400.
 *
 * `conversationId` is optional — omit it for a standalone manual admin order;
 * when present it must reference an existing conversation. `source` defaults to
 * 'messenger' server-side. Per-item `qty` defaults to 1.
 */
export const createOrderBodySchema = z
  .object({
    conversationId: z.uuid().optional(),
    source: z.enum(ORDER_SOURCES).optional(),
    phone: z.string().min(1),
    address: z.string().min(1),
    unifiedSize: z.string().optional(),
    items: z
      .array(
        z
          .object({
            productId: z.uuid(),
            storageKey: z.string().min(1),
            size: z.string().optional(),
            qty: z.coerce.number().int().positive().default(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;
export class CreateOrderDto extends createZodDto(createOrderBodySchema) {}
