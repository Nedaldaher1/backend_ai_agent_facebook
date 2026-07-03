/**
 * Write-tool identity test (DoD #3b from AIA-27).
 *
 * Proves that a WRITE tool (escalate_to_human) takes customer identity from
 * requestContext, never from its tool input schema.
 *
 * This lives in its own file so that the jest.mock('@mastra/core/tools', ...)
 * passthrough does not clash with the @mastra/core/di mock already registered
 * in agent.service.spec.ts.
 */

jest.mock('@mastra/core/tools', () => ({
  // Passthrough: createTool(cfg) returns cfg so tool.execute is callable directly.
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

// flydrive is ESM-only; stub it so Jest doesn't attempt to load the real module.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));

import { buildEscalateToHumanTool } from '../tools/escalate-to-human.tool';
import type { ConversationsService } from '@/modules/conversations/conversations.service';

describe('write-tool identity (AIA-27 DoD #3b)', () => {
  it('escalate_to_human reads conversationId from requestContext, not tool input', async () => {
    const escalateToHuman = jest.fn().mockResolvedValue({ id: 'conv-9' });
    const conversations = {
      escalateToHuman,
    } as unknown as ConversationsService;

    // createTool passthrough means the returned object IS the config object.
    const tool = buildEscalateToHumanTool(conversations) as unknown as {
      execute: (
        input: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<unknown>;
    };

    await tool.execute(
      { reason: 'x' },
      {
        requestContext: {
          get: (k: string) => ({ conversationId: 'conv-9' })[k],
        },
      },
    );

    expect(escalateToHuman).toHaveBeenCalledWith('conv-9', 'x');
  });
});
