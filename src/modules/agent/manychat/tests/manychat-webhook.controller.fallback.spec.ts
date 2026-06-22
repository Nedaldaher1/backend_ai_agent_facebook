/**
 * Strengthened tests for ManyChatWebhookController: the WS4 "never-5xx" contract.
 *
 * The sync `handle()` method must ALWAYS resolve to a valid v2 Dynamic Block,
 * even when AgentService.handleMessage rejects or when enrichWithImages throws.
 * Any failure path must return the Arabic fallback string, not propagate the
 * error or return 5xx to ManyChat.
 *
 * These tests complement the existing basic-coverage spec and do not duplicate
 * any case already covered there.
 */

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
jest.mock('../../mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));

import { ManyChatWebhookController } from '../manychat-webhook.controller';
import type { AgentService } from '../../agent.service';
import type { ProductsService } from '@/modules/products/products.service';
import type { DebounceService } from '../../debounce/debounce.service';
import type { ManyChatSenderService } from '../manychat-sender.service';
import type { ManyChatTextMessage } from '../manychat.types';

// The exact Arabic fallback text from the controller (copied from source).
const FALLBACK_ARABIC =
  'لحظة من فضلك 🌸 عم نجهّزلك الرد، جرّبي تبعتي رسالتك بعد شوي.';

// ---------------------------------------------------------------------------
// Factory helpers (mirrors the pattern in the existing controller spec)
// ---------------------------------------------------------------------------

function makeController(overrides: {
  agentBehaviour?: () => Promise<{ reply: string; products?: Array<{ id: string; name: string; price: string }>; productOverflow?: number }>;
  mediaBehaviour?: (id: string) => Promise<{ url: string; type: string }[]>;
}): ManyChatWebhookController {
  const { agentBehaviour, mediaBehaviour } = overrides;

  const agent = {
    handleMessage: jest.fn().mockImplementation(agentBehaviour ?? (() => Promise.resolve({ reply: 'أهلاً' }))),
  } as unknown as AgentService;

  const products = {
    getMedia: jest.fn().mockImplementation(mediaBehaviour ?? (() => Promise.resolve([]))),
  } as unknown as ProductsService;

  const debounce = {
    enqueue: jest.fn(),
  } as unknown as DebounceService;

  const sender = {
    sendReply: jest.fn().mockResolvedValue(true),
  } as unknown as ManyChatSenderService;

  return new ManyChatWebhookController(agent, products, debounce, sender);
}

// ---------------------------------------------------------------------------
// Never-5xx contract
// ---------------------------------------------------------------------------

describe('ManyChatWebhookController — never-5xx fallback (WS4)', () => {
  const minimalDto = { contactId: 'C1', text: 'مرحبا' };

  it('resolves (does not throw) when AgentService.handleMessage rejects', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('DB connection refused')),
    });
    await expect(controller.handle(minimalDto)).resolves.toBeDefined();
  });

  it('returns version==="v2" when AgentService.handleMessage rejects', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('Claude 500')),
    });
    const block = await controller.handle(minimalDto);
    expect(block.version).toBe('v2');
  });

  it('returns the Arabic fallback as the first text message when the agent throws', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('timeout')),
    });
    const block = await controller.handle(minimalDto);
    const firstMessage = block.content.messages[0] as ManyChatTextMessage;
    expect(firstMessage.type).toBe('text');
    expect(firstMessage.text).toBe(FALLBACK_ARABIC);
  });

  it('returns content.actions=[] and content.quick_replies=[] on fallback', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('any error')),
    });
    const block = await controller.handle(minimalDto);
    expect(block.content.actions).toEqual([]);
    expect(block.content.quick_replies).toEqual([]);
  });

  it('resolves to a valid v2 block when enrichWithImages throws (DB/products failure)', async () => {
    // Agent succeeds but product media lookup (enrichWithImages) throws.
    const controller = makeController({
      agentBehaviour: () =>
        Promise.resolve({
          reply: 'خيارات',
          products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
          productOverflow: 0,
        }),
      mediaBehaviour: () => Promise.reject(new Error('R2 storage down')),
    });

    // Even though getMedia rejects, handle() catches it per-product (best-effort)
    // and enrichWithImages should NOT propagate the error from a single product.
    // The block must still be returned (not thrown).
    const block = await controller.handle(minimalDto);
    expect(block.version).toBe('v2');
  });

  it('returns the fallback when an unexpected synchronous throw occurs inside handle', async () => {
    // Simulates an edge case where handleMessage throws synchronously
    // (e.g. a ReferenceError in a callback).
    const controller = makeController({
      agentBehaviour: () => {
        throw new ReferenceError('unexpected sync error');
      },
    });
    const block = await controller.handle(minimalDto);
    expect(block.version).toBe('v2');
    const first = block.content.messages[0] as ManyChatTextMessage;
    expect(first.text).toBe(FALLBACK_ARABIC);
  });

  it('fallback block has exactly one text message (the Arabic fallback)', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('network error')),
    });
    const block = await controller.handle(minimalDto);
    expect(block.content.messages).toHaveLength(1);
    expect(block.content.messages[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Async path never-silent fallback (audit R1)
// ---------------------------------------------------------------------------

describe('ManyChatWebhookController — async path never-silent fallback (audit R1)', () => {
  // Reaches into the private worker the debounce callback invokes. Unlike the
  // sync handle(), the async path delivers out-of-band via the Send API after a
  // 202 ACK, so a failed turn must still push the Arabic fallback (before the
  // fix it pushed nothing and the customer got total silence).
  type WithProcessBatch = {
    processBatch(contactId: string, items: { contactId: string; text: string }[]): Promise<void>;
    sender: { sendReply: jest.Mock };
  };

  it('delivers the Arabic fallback via the Send API when the async turn throws', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('Claude 429')),
    }) as unknown as WithProcessBatch;

    await controller.processBatch('C9', [{ contactId: 'C9', text: 'مرحبا' }]);

    expect(controller.sender.sendReply).toHaveBeenCalledTimes(1);
    const block = controller.sender.sendReply.mock.calls[0][1];
    const first = block.content.messages[0] as ManyChatTextMessage;
    expect(first.type).toBe('text');
    expect(first.text).toBe(FALLBACK_ARABIC);
  });

  it('does not throw out of processBatch when BOTH the turn and the fallback send fail', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.reject(new Error('turn failed')),
    }) as unknown as WithProcessBatch;
    controller.sender.sendReply.mockRejectedValue(new Error('ManyChat down'));

    await expect(
      controller.processBatch('C9', [{ contactId: 'C9', text: 'x' }]),
    ).resolves.toBeUndefined();
  });

  it('on a successful async turn it sends the real reply, not the fallback', async () => {
    const controller = makeController({
      agentBehaviour: () => Promise.resolve({ reply: 'أهلاً وسهلاً' }),
    }) as unknown as WithProcessBatch;

    await controller.processBatch('C9', [{ contactId: 'C9', text: 'مرحبا' }]);

    const block = controller.sender.sendReply.mock.calls[0][1];
    const first = block.content.messages[0] as ManyChatTextMessage;
    expect(first.text).toBe('أهلاً وسهلاً');
  });
});
