/**
 * Unit tests for MessengerWebhookController — WS3 ad-attribution additions.
 *
 * Covers:
 *  1. Content-less event with referral → persistAttributionOnly called (no enqueue).
 *  2. Content-less event without referral → no enqueue, no attribution call.
 *  3. Content-bearing event with referral → enqueued with full referral object.
 *  4. toIncoming: maps referral.ref to adRef AND to referral.ref.
 *  5. toIncoming: maps referral.source to referral.adSource.
 *  6. toIncoming: maps adsContext.product_id to referral.adProductId.
 *  7. toIncoming: includes referral.adContext (the full adsContext).
 *  8. persistAttributionOnly failure does NOT break the 200 response.
 *  9. extractReferral precedence respected on content-less events.
 */

// Same mocks as the main controller spec
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
jest.mock('../../../agent/mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));

import { MessengerWebhookController } from '../messenger-webhook.controller';
import type { AgentService } from '../../agent.service';
import type { ProductsService } from '@/modules/products/products.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { DebounceService } from '../../debounce/debounce.service';
import type { MessengerClient } from '../messenger.client';
import type { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERIFY_TOKEN = 'test-verify-token';

function makeConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === 'MESSENGER_VERIFY_TOKEN' ? VERIFY_TOKEN : undefined,
  } as unknown as ConfigService;
}

interface ControllerOpts {
  attributionResolves?: boolean; // default true
  findOrCreateId?: string;
}

function makeController(opts: ControllerOpts = {}) {
  const agent: AgentService = {
    handleMessage: jest.fn().mockResolvedValue({ reply: 'أهلاً', ran: true, aiState: 'bot' }),
  } as unknown as AgentService;

  const products: ProductsService = {
    getMedia: jest.fn().mockResolvedValue([]),
  } as unknown as ProductsService;

  const conversationId = opts.findOrCreateId ?? 'conv-ws3';
  const conversations: ConversationsService = {
    findOrCreateByPsid: jest.fn().mockResolvedValue({ id: conversationId, aiState: 'bot' }),
    recordFirstTouchAttribution: jest.fn().mockResolvedValue(
      opts.attributionResolves === false
        ? Promise.reject(new Error('DB error'))
        : { id: conversationId, attributedAt: new Date() },
    ),
  } as unknown as ConversationsService;

  let lastFlush: Promise<void> | undefined;
  const debounce: DebounceService = {
    enqueue: jest.fn((_k: string, item: unknown, flush: (items: unknown[]) => Promise<void>) => {
      lastFlush = Promise.resolve(flush([item]));
    }),
  } as unknown as DebounceService;

  const messengerClient: MessengerClient = {
    sendText: jest.fn().mockResolvedValue(undefined),
    senderAction: jest.fn().mockResolvedValue(undefined),
    sendTemplate: jest.fn().mockResolvedValue(undefined),
  } as unknown as MessengerClient;

  const controller = new MessengerWebhookController(
    agent,
    products,
    conversations,
    debounce,
    messengerClient,
    makeConfig(),
  );

  return { controller, agent, conversations, debounce, messengerClient, flush: () => lastFlush };
}

function makeReq(body: unknown): FastifyRequest {
  return { body } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// Helper: a pure messaging_referrals event (no text, no image, no postback)
// ---------------------------------------------------------------------------

function makeReferralOnlyEntry(psid: string, ref: string) {
  return {
    object: 'page',
    entry: [
      {
        id: 'PAGE-1',
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: 'PAGE-1' },
            timestamp: Date.now(),
            // No message, no postback — pure referral event
            referral: { ref, source: 'ADS', type: 'OPEN_THREAD' },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Content-less referral event → persistAttributionOnly, no enqueue
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — WS3: content-less referral events', () => {
  it('does NOT enqueue a content-less referral-only event (no message/postback)', async () => {
    const { controller, debounce } = makeController();
    const req = makeReq(makeReferralOnlyEntry('PSID-REF', 'summer-2024'));

    controller.handleWebhook(req);
    // Give the void attribution a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(debounce.enqueue).not.toHaveBeenCalled();
  });

  it('calls findOrCreateByPsid + recordFirstTouchAttribution for content-less referral', async () => {
    const { controller, conversations } = makeController();
    const req = makeReq(makeReferralOnlyEntry('PSID-REF2', 'winter-ad'));

    controller.handleWebhook(req);
    await new Promise((r) => setTimeout(r, 10));

    expect(conversations.findOrCreateByPsid).toHaveBeenCalledWith('PSID-REF2');
    expect(conversations.recordFirstTouchAttribution).toHaveBeenCalledWith(
      'conv-ws3',
      expect.objectContaining({ adRef: 'winter-ad', adSource: 'ADS' }),
    );
  });

  it('still returns { status: ok } when persistAttributionOnly throws', async () => {
    const { controller } = makeController({ attributionResolves: false });
    const req = makeReq(makeReferralOnlyEntry('PSID-ERR', 'some-ref'));

    // The controller returns synchronously with 200 — attribution is fire-and-forget.
    const result = controller.handleWebhook(req);
    expect(result).toEqual({ status: 'ok' });

    // Let the failed promise resolve without blowing up the test.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('does NOT call recordFirstTouchAttribution for a content-less event WITHOUT referral', async () => {
    // A delivery/read receipt that snuck through: no message, no postback, no referral.
    const { controller, conversations, debounce } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-READ' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              delivery: { watermark: Date.now() }, // delivery receipt
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);
    await new Promise((r) => setTimeout(r, 10));

    expect(debounce.enqueue).not.toHaveBeenCalled();
    expect(conversations.recordFirstTouchAttribution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Content-bearing event with referral → enqueued with full referral object
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — WS3: toIncoming referral mapping', () => {
  it('includes referral.ref as adRef AND as referral.ref in the enqueued IncomingMessage', () => {
    const { controller, debounce } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: {
                mid: 'mid-1',
                text: 'مرحبا',
                referral: { ref: 'ad-slug-1', source: 'ADS', type: 'OPEN_THREAD' },
              },
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledWith(
      'PSID-1',
      expect.objectContaining({
        adRef: 'ad-slug-1',
        referral: expect.objectContaining({ ref: 'ad-slug-1' }),
      }),
      expect.any(Function),
    );
  });

  it('maps referral.source to referral.adSource', () => {
    const { controller, debounce } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-2' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: {
                mid: 'mid-2',
                text: 'hi',
                referral: { ref: 'r', source: 'SHORTLINK' },
              },
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledWith(
      'PSID-2',
      expect.objectContaining({
        referral: expect.objectContaining({ adSource: 'SHORTLINK' }),
      }),
      expect.any(Function),
    );
  });

  it('maps adsContext.product_id to referral.adProductId', () => {
    const { controller, debounce } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-3' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: {
                mid: 'mid-3',
                text: 'hi',
                referral: {
                  ref: 'r2',
                  ad_id: 'ad_456',
                  ads_context_data: {
                    ad_title: 'العباية الصيفية',
                    product_id: 'sku-black-abaya',
                  },
                },
              },
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledWith(
      'PSID-3',
      expect.objectContaining({
        referral: expect.objectContaining({
          adProductId: 'sku-black-abaya',
          adId: 'ad_456',
          adContext: expect.objectContaining({ ad_title: 'العباية الصيفية' }),
        }),
      }),
      expect.any(Function),
    );
  });

  it('omits the referral field from the enqueued message when the event has no referral', () => {
    const { controller, debounce } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-4' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: { mid: 'mid-4', text: 'مرحبا' },
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);

    const enqueueArg = (debounce.enqueue as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(enqueueArg.referral).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. extractReferral precedence on content-less events
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — WS3: extractReferral precedence on content-less events', () => {
  it('uses top-level event.referral when the event has no message (returning-user shape)', async () => {
    const { controller, conversations } = makeController();
    const req = makeReq({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-5' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              referral: { ref: 'returning-ref', source: 'SHORTLINK', type: 'OPEN_THREAD' },
            },
          ],
        },
      ],
    });

    controller.handleWebhook(req);
    await new Promise((r) => setTimeout(r, 10));

    expect(conversations.recordFirstTouchAttribution).toHaveBeenCalledWith(
      'conv-ws3',
      expect.objectContaining({ adRef: 'returning-ref' }),
    );
  });
});
