/**
 * Tests for buildEscalateToHumanTool.
 *
 * This is a WRITE tool: identity (conversationId) comes from requestContext only.
 */

jest.mock('@mastra/core/tools', () => ({
  createTool: (cfg: Record<string, unknown>) => cfg,
}));

import { buildEscalateToHumanTool } from '../escalate-to-human.tool';
import { HANDOFF_REPLY } from '../../handoff.constants';
import type { ConversationsService } from '@/modules/conversations/conversations.service';

// ---------------------------------------------------------------------------
// Fake requestContext helper (mirrors the pattern in the task brief)
// ---------------------------------------------------------------------------

function ctx(vals: Record<string, string>) {
  return {
    requestContext: { get: (k: string) => vals[k] },
  };
}

// ---------------------------------------------------------------------------
// Minimal conversations mock
// ---------------------------------------------------------------------------

function makeConversationsMock(
  escalateImpl: jest.Mock,
): ConversationsService {
  return {
    escalateToHuman: escalateImpl,
  } as unknown as ConversationsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildEscalateToHumanTool', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  it('calls escalateToHuman with (conversationId, reason) and returns { escalated: true, message: HANDOFF_REPLY }', async () => {
    const escalateToHuman = jest.fn().mockResolvedValue({ id: 'conv-1' });
    const conversations = makeConversationsMock(escalateToHuman);
    const tool = buildEscalateToHumanTool(conversations) as any;

    const result = await tool.execute(
      { reason: 'شحن دولي' },
      ctx({ conversationId: 'conv-1' }),
    );

    expect(escalateToHuman).toHaveBeenCalledWith('conv-1', 'شحن دولي');
    expect(result).toEqual({ escalated: true, message: HANDOFF_REPLY });
  });

  // -------------------------------------------------------------------------
  // Identity absent
  // -------------------------------------------------------------------------
  it('rejects when conversationId is absent from requestContext', async () => {
    const escalateToHuman = jest.fn();
    const conversations = makeConversationsMock(escalateToHuman);
    const tool = buildEscalateToHumanTool(conversations) as any;

    await expect(
      tool.execute({ reason: 'اختبار' }, ctx({})),
    ).rejects.toThrow();

    expect(escalateToHuman).not.toHaveBeenCalled();
  });

  it('rejects when no context object is passed at all', async () => {
    const escalateToHuman = jest.fn();
    const conversations = makeConversationsMock(escalateToHuman);
    const tool = buildEscalateToHumanTool(conversations) as any;

    await expect(tool.execute({ reason: 'اختبار' })).rejects.toThrow();

    expect(escalateToHuman).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Input schema shape
  // -------------------------------------------------------------------------
  it('inputSchema has only the "reason" key (no conversationId or psid)', () => {
    const tool = buildEscalateToHumanTool(
      makeConversationsMock(jest.fn()),
    ) as any;

    const keys = Object.keys(tool.inputSchema.shape);
    expect(keys).toEqual(['reason']);
    expect(keys).not.toContain('conversationId');
    expect(keys).not.toContain('psid');
  });

  it('outputSchema includes escalated (boolean) and message (string)', () => {
    const tool = buildEscalateToHumanTool(
      makeConversationsMock(jest.fn()),
    ) as any;

    const keys = Object.keys(tool.outputSchema.shape);
    expect(keys).toContain('escalated');
    expect(keys).toContain('message');
  });
});
