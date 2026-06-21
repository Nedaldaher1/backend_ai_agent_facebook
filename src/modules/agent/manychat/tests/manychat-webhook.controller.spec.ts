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
import type { ManyChatCardsMessage } from '../manychat.types';

function makeController(opts: {
  reply: {
    reply: string;
    products?: Array<{ id: string; name: string; price: string }>;
  };
  media?: Record<string, { url: string; type: string }[]>;
}) {
  const agent = {
    handleMessage: jest.fn().mockResolvedValue(opts.reply),
  } as unknown as AgentService;
  const products = {
    getMedia: jest.fn(async (id: string) => opts.media?.[id] ?? []),
  } as unknown as ProductsService;
  const controller = new ManyChatWebhookController(agent, products);
  return { controller, agent, products };
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
});
