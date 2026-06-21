/**
 * recommend_size — أوصي بمقاس العباءة بناءً على وزن الزبونة.
 *
 * Thin tool: calls SizingService.recommendSize and returns its result
 * with the only transform being a camelCase→snake_case key rename
 * (needsHuman → needs_human). No logic or calculation here.
 *
 * Identity is NOT needed: weight comes from the conversation as a tool input,
 * not from the request context. This is a pure read tool.
 *
 * If the result carries needs_human=true the agent should escalate
 * via escalate_to_human.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { SizingService } from '@/modules/sizing/sizing.service';

const inputSchema = z.object({
  weight_kg: z
    .number()
    .positive()
    .describe('وزن الزبونة بالكيلوغرام'),
  height_cm: z
    .number()
    .positive()
    .optional()
    .describe('طول الزبونة بالسنتيمتر (اختياري)'),
});

const outputSchema = z.object({
  size: z.string().nullable(),
  note: z.string().optional(),
  needs_human: z.boolean().optional(),
});

export function buildRecommendSizeTool(sizing: SizingService) {
  return createTool({
    id: 'recommend_size',
    description:
      'تحديد مقاس العباءة المناسب بناءً على وزن الزبونة (الطول اختياري). إذا أعادت الأداة needs_human=true يجب تحويل الزبونة إلى موظف بشري عبر escalate_to_human.',
    inputSchema,
    outputSchema,

    execute: async (input) => {
      const r = await sizing.recommendSize(input.weight_kg, input.height_cm);
      return {
        size: r.size,
        note: r.note,
        needs_human: r.needsHuman,
      };
    },
  });
}
