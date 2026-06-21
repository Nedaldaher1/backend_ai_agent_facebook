/**
 * Unit tests for ManyChatWebhookController. The live ManyChat round-trip can't be
 * exercised here; these lock the field mapping (messageId → externalMessageId),
 * image enrichment, and the Dynamic Block output. Heavy ESM deps reached via the
 * AgentService / ProductsService imports are stubbed (same pattern as the agent
 * specs).
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
import type { ManyChatCardsMessage } from '../manychat.types';

function makeController(opts: {
  reply: {
    reply: string;
    products?: Array<{ id: string; name: string; price: string }>;
    productOverflow?: number;
  };
  media?: Record<string, { url: string; type: string }[]>;
}) {
  const agent = {
    handleMessage: jest.fn().mockResolvedValue(opts.reply),
  } as unknown as AgentService;
  const products = {
    getMedia: jest.fn(async (id: string) => opts.media?.[id] ?? []),
  } as unknown as ProductsService;

  // Debounce stand-in: invoke the flush immediately with the single item and
  // capture its promise so a test can await the batch processing.
  let lastFlush: Promise<void> | undefined;
  const debounce = {
    enqueue: jest.fn(
      (
        _key: string,
        item: unknown,
        flush: (items: unknown[]) => Promise<void>,
      ) => {
        lastFlush = Promise.resolve(flush([item]));
      },
    ),
  } as unknown as DebounceService;
  const sender = {
    sendReply: jest.fn().mockResolvedValue(true),
  } as unknown as ManyChatSenderService;

  const controller = new ManyChatWebhookController(
    agent,
    products,
    debounce,
    sender,
  );
  return {
    controller,
    agent,
    products,
    debounce,
    sender,
    flush: () => lastFlush,
  };
}

describe('ManyChatWebhookController', () => {
  it('maps messageId to externalMessageId and passes the turn to the agent', async () => {
    const { controller, agent } = makeController({ reply: { reply: 'أهلاً' } });

    await controller.handle({
      contactId: 'C1',
      text: 'مرحبا',
      messageId: 'mid-7',
    });

    expect(agent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'C1',
        text: 'مرحبا',
        externalMessageId: 'mid-7',
      }),
    );
  });

  it('enriches product cards with resolved image URLs', async () => {
    const { controller } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      },
      media: { p1: [{ url: 'https://cdn/p1.jpg', type: 'image' }] },
    });

    const block = await controller.handle({ contactId: 'C1', text: 'بدي عباية' });

    const cards = block.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements[0]).toMatchObject({
      title: 'عباية',
      image_url: 'https://cdn/p1.jpg',
    });
  });

  it('returns a v2 block with empty messages for a deduped (empty) reply', async () => {
    const { controller } = makeController({ reply: { reply: '' } });

    const block = await controller.handle({
      contactId: 'C1',
      text: 'مكرر',
      messageId: 'm',
    });

    expect(block.version).toBe('v2');
    expect(block.content.messages).toEqual([]);
  });

  it('still returns cards when a product image lookup fails (best-effort)', async () => {
    const { controller, products } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      },
    });
    (products.getMedia as jest.Mock).mockRejectedValue(new Error('storage down'));

    const block = await controller.handle({ contactId: 'C1', text: 'x' });

    const cards = block.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements[0].image_url).toBeUndefined();
  });

  it('handleAsync returns 202 status and enqueues the turn for debounce', () => {
    const { controller, debounce } = makeController({ reply: { reply: 'x' } });

    const res = controller.handleAsync({
      contactId: 'C1',
      text: 'مرحبا',
      messageId: 'm1',
    });

    expect(res).toEqual({ status: 'accepted' });
    expect(debounce.enqueue).toHaveBeenCalledWith(
      'C1',
      expect.objectContaining({ externalMessageId: 'm1' }),
      expect.any(Function),
    );
  });

  it('the debounce flush runs the agent on the merged turn and delivers via Send API', async () => {
    const { controller, agent, sender, flush } = makeController({
      reply: {
        reply: 'هلا',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      },
      media: { p1: [{ url: 'https://cdn/p1.jpg', type: 'image' }] },
    });

    controller.handleAsync({
      contactId: 'C1',
      text: 'بدي عباية',
      messageId: 'm1',
    });
    await flush();

    expect(agent.handleMessage).toHaveBeenCalled();
    expect(sender.sendReply).toHaveBeenCalledWith(
      'C1',
      expect.objectContaining({ version: 'v2' }),
    );
  });

  it('sync handle passes productOverflow to toDynamicBlock (overflow note in messages)', async () => {
    const { controller } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
        productOverflow: 4,
      },
    });

    const block = await controller.handle({ contactId: 'C1', text: 'بدي عباية' });

    const texts = block.content.messages.filter((m) => m.type === 'text');
    // First text = reply; second text = overflow note
    expect(texts.length).toBeGreaterThanOrEqual(2);
    const note = texts[texts.length - 1] as import('../manychat.types').ManyChatTextMessage;
    expect(note.text).toContain('4');
  });

  it('async processBatch passes productOverflow to the delivered block', async () => {
    const { controller, sender, flush } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
        productOverflow: 2,
      },
    });

    controller.handleAsync({ contactId: 'C1', text: 'بدي عباية', messageId: 'm1' });
    await flush();

    const deliveredBlock = (sender.sendReply as jest.Mock).mock.calls[0][1] as import('../manychat.types').ManyChatDynamicBlock;
    const texts = deliveredBlock.content.messages.filter((m) => m.type === 'text');
    expect(texts.length).toBeGreaterThanOrEqual(2);
    const note = texts[texts.length - 1] as import('../manychat.types').ManyChatTextMessage;
    expect(note.text).toContain('2');
  });
});

