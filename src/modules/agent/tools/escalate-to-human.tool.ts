/**
 * escalate_to_human — تحويل المحادثة إلى موظف بشري.
 *
 * WRITE tool. Marks the conversation with stage: 'needs_human' in the state
 * jsonb so the admin panel and ManyChat webhook can route it to a human agent.
 *
 * Customer identity (conversationId) comes ONLY from requestContext — never
 * from the tool input.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ConversationsService } from '@/modules/conversations/conversations.service';

const inputSchema = z.object({
  reason: z
    .string()
    .describe(
      'سبب التحويل إلى موظف (مثال: استفسار عن الشحن الدولي، طلب تعديل خاص)',
    ),
});

const outputSchema = z.object({
  escalated: z.boolean(),
});

export function buildEscalateToHumanTool(conversations: ConversationsService) {
  return createTool({
    id: 'escalate_to_human',
    description:
      'حوّلي المحادثة إلى موظف بشري عندما لا تستطيعين مساعدة الزبونة أو عند طلبها ذلك.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Identity MUST come from requestContext — never from tool input.
      const conversationId = ctx?.requestContext?.get('conversationId') as
        | string
        | undefined;
      if (!conversationId) {
        throw new Error(
          'لا يمكن التحويل: هوية المحادثة غير متوفرة في السياق.',
        );
      }

      await conversations.escalateToHuman(conversationId, input.reason);
      return { escalated: true };
    },
  });
}
