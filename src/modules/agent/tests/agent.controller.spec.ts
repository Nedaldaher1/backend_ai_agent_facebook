/**
 * Regression test (audit S1): the TEMPORARY POST /agent/message dev surface must
 * be guarded by ManyChatSecretGuard, exactly like the real ManyChat webhook.
 *
 * Before the fix the controller carried NO @UseGuards, so anyone who could reach
 * the host had unauthenticated access to the full agent pipeline — Claude calls,
 * the capture_order / escalate_to_human write tools, per-contact history
 * poisoning (attacker-chosen contactId), and the server-side image fetch. The
 * ManyChatSecretGuard on /webhook/manychat was fully sidestepped.
 */

import 'reflect-metadata';

// AgentController value-imports AgentService, which pulls in the Mastra / vision /
// storage module graph. Mock those heavy deps so the import resolves under Jest
// (mirrors the manychat controller specs).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
jest.mock('@huggingface/transformers', () => ({
  AutoProcessor: { from_pretrained: jest.fn() },
  AutoTokenizer: { from_pretrained: jest.fn() },
  RawImage: { read: jest.fn(), fromBlob: jest.fn() },
  SiglipTextModel: { from_pretrained: jest.fn() },
  SiglipVisionModel: { from_pretrained: jest.fn() },
  env: {},
}));
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));
jest.mock('@mastra/core/di', () => ({ RequestContext: jest.fn() }));
jest.mock('../mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));

import { AgentController } from '../agent.controller';
import { ManyChatSecretGuard } from '../manychat/manychat-secret.guard';

describe('AgentController — auth guard (audit S1)', () => {
  it('is protected by ManyChatSecretGuard at the controller level', () => {
    const guards: unknown[] =
      Reflect.getMetadata('__guards__', AgentController) ?? [];
    expect(guards).toContain(ManyChatSecretGuard);
  });
});
