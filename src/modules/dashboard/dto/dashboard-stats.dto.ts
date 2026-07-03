/**
 * Response contract for GET /admin/dashboard — every aggregate the overview
 * page shows, computed server-side in one round-trip so the admin panel never
 * pages raw rows just to count them client-side.
 */

import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ORDER_STATUSES } from '@/modules/orders/entities/order.entity';
import { AI_STATES } from '@/modules/conversations/entities/conversation.entity';

const countsFrom = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.object(
    Object.fromEntries(keys.map((k) => [k, z.number().int().min(0)])) as {
      [K in T[number]]: z.ZodNumber;
    },
  );

export const dashboardStatsSchema = z.object({
  products: z.object({
    total: z.number().int().min(0),
    published: z.number().int().min(0),
  }),
  orders: z.object({
    total: z.number().int().min(0),
    byStatus: countsFrom(ORDER_STATUSES),
    /** Orders per staff-local calendar day, oldest first; empty days absent. */
    byDay: z.array(
      z.object({
        /** Local calendar day, `YYYY-MM-DD`. */
        day: z.string(),
        count: z.number().int().min(0),
      }),
    ),
  }),
  conversations: z.object({
    total: z.number().int().min(0),
    byState: countsFrom(AI_STATES),
    escalated: z.number().int().min(0),
  }),
});

export type DashboardStats = z.infer<typeof dashboardStatsSchema>;

/** OpenAPI DTO class (nestjs-zod createZodDto for Scalar docs integration). */
export class DashboardStatsDto extends createZodDto(dashboardStatsSchema) {}
