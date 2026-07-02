/**
 * escalate_to_human — تحويل المحادثة إلى موظف بشري.
 *
 * WRITE tool. Sets the conversation's ai_state column to 'human' (with the
 * escalation reason) and records a handoff event, so the admin panel and the
 * code gate route it to a human agent. The ai_state column is the source of
 * truth; subsequent turns from the same customer are silently dropped by the
 * bot-pause gate in AgentService until an admin resumes the conversation.
 *
 * Customer identity (conversationId) comes ONLY from requestContext — never
 * from the tool input.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import { HANDOFF_REPLY } from '../handoff.constants';

const inputSchema = z.object({
  reason: z
    .string()
    .describe('Why the handoff is needed (e.g. complaint, special request)'),
});

const outputSchema = z.object({
  escalated: z.boolean(),
  message: z.string(),
});

export function buildEscalateToHumanTool(conversations: ConversationsService) {
  return createTool({
    id: 'escalate_to_human',
    description:
      'Hand the conversation to a human agent when you cannot help or the customer asks for one.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Identity MUST come from requestContext — never from tool input.
      const conversationId = ctx?.requestContext?.get('conversationId');
      if (!conversationId) {
        throw new Error('لا يمكن التحويل: هوية المحادثة غير متوفرة في السياق.');
      }

      await conversations.escalateToHuman(conversationId, input.reason);
      return { escalated: true, message: HANDOFF_REPLY };
    },
  });
}
