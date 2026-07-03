/**
 * Unit tests for MessengerWebhookController.
 *
 * Covers:
 *  - GET /webhook/messenger: echoes hub.challenge on valid verify_token (200).
 *  - GET /webhook/messenger: 403 on mismatched token.
 *  - GET /webhook/messenger: 403 when mode !== subscribe.
 *  - POST: non-page object → 200, ignore (no enqueue).
 *  - POST: body parse error → 200, ignore.
 *  - POST: normal message is enqueued to DebounceService.
 *  - POST: batched entries + multiple messaging events all enqueued.
 *  - POST: duplicate mid within one POST body is deduped (enqueued once).
 *  - Async worker: mark_seen + agent.handleMessage + typing_on + sendText +
 *    sendTemplate (with carousel) + typing_off.
 *  - Async worker: !reply.ran → no send.
 *  - Async worker: agent throws → fallback Arabic text sent.
 *  - Async worker: fallback send also fails → does not throw.
 *  - Async worker: image product enrichment (best-effort, failure leaves card without image).
 */

// Mock ESM-only dependencies needed transitively through agent.service
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));
jest.mock('@mastra/core/di', () => ({ RequestContext: jest.fn() }));
jest.mock('../../../agent/mastra/mastra.factory', () => ({
  buildMastra: jest.fn(),
}));

import { MessengerWebhookController } from '../messenger-webhook.controller';
import type { AgentService } from '../../agent.service';
import type { ProductsService } from '@/modules/products/products.service';
import type { DebounceService } from '../../debounce/debounce.service';
import type { MessengerClient } from '../messenger.client';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERIFY_TOKEN = 'test-verify-token';

function makeConfig(
  env: Record<string, string | undefined> = {},
): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

interface MakeControllerOpts {
  reply?: {
    reply: string;
    products?: Array<{ id: string; name: string; price: string }>;
    productOverflow?: number;
    images?: string[];
    ran?: boolean;
    aiState?: 'bot' | 'human' | 'paused';
  };
  media?: Record<string, { url: string; type: string }[]>;
  /** Pass null to explicitly omit MESSENGER_VERIFY_TOKEN from config. */
  verifyToken?: string | null;
  agentThrows?: boolean;
  /** Set false to disable human pacing (single-message mode). Default: enabled. */
  pacingEnabled?: boolean;
  /** Set true to enable the voice-note gate (TRANSCRIPTION_ENABLED). Default: off. */
  transcriptionEnabled?: boolean;
}

function makeController(opts: MakeControllerOpts) {
  const baseReply = opts.reply ?? {
    reply: 'أهلاً',
    ran: true,
    aiState: 'bot' as const,
  };
  const agent = {
    handleMessage: opts.agentThrows
      ? jest.fn().mockRejectedValue(new Error('Agent failed'))
      : jest.fn().mockResolvedValue(baseReply),
  } as unknown as AgentService;

  const products = {
    getMedia: jest.fn(async (id: string) => opts.media?.[id] ?? []),
  } as unknown as ProductsService;

  // Minimal ConversationsService stub — the existing tests don't exercise WS3
  // paths so they just need the service to exist without throwing.
  const conversations = {
    findOrCreateByPsid: jest
      .fn()
      .mockResolvedValue({ id: 'conv-stub', aiState: 'bot' }),
    recordFirstTouchAttribution: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('@/modules/conversations/conversations.service').ConversationsService;

  // Debounce stand-in: invoke the flush immediately so tests can await async work
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

  const messengerClient = {
    sendText: jest.fn().mockResolvedValue(undefined),
    senderAction: jest.fn().mockResolvedValue(undefined),
    sendTemplate: jest.fn().mockResolvedValue(undefined),
    sendImage: jest.fn().mockResolvedValue(undefined),
  } as unknown as MessengerClient;

  // Build the config env. Zero-delay pacing by default so the async batch
  // resolves instantly (we still exercise the split + send choreography).
  const configEnv: Record<string, string | undefined> = {
    MESSENGER_TYPING_MS_PER_CHAR: '0',
    MESSENGER_TYPING_MIN_MS: '0',
    MESSENGER_TYPING_MAX_MS: '0',
    MESSENGER_MAX_BUBBLES: '10',
  };
  // verifyToken=null means omit the key entirely.
  if (opts.verifyToken !== null) {
    configEnv.MESSENGER_VERIFY_TOKEN = opts.verifyToken ?? VERIFY_TOKEN;
  }
  if (opts.pacingEnabled === false) {
    configEnv.MESSENGER_HUMAN_PACING_ENABLED = 'false';
  }
  if (opts.transcriptionEnabled) {
    configEnv.TRANSCRIPTION_ENABLED = 'true';
  }

  const config = makeConfig(configEnv);

  const controller = new MessengerWebhookController(
    agent,
    products,
    conversations,
    debounce,
    messengerClient,
    config,
  );

  return {
    controller,
    agent,
    products,
    conversations,
    debounce,
    messengerClient,
    flush: () => lastFlush,
  };
}

/** Build a minimal valid POST body for the webhook. */
function makeBody(
  messagingOverrides: Record<string, unknown> = {},
  object = 'page',
) {
  return {
    body: {
      object,
      entry: [
        {
          id: 'PAGE-123',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE-123' },
              timestamp: Date.now(),
              message: { mid: 'mid-1', text: 'مرحبا' },
              ...messagingOverrides,
            },
          ],
        },
      ],
    },
  };
}

/** Stub a FastifyReply with status().type().send() chaining. */
function makeReply(): FastifyReply {
  const send = jest.fn();
  const type = jest.fn().mockReturnValue({ send });
  const status = jest.fn().mockReturnValue({ type, send });
  return { status } as unknown as FastifyReply;
}

// ---------------------------------------------------------------------------
// GET /webhook/messenger — verification
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — GET /webhook/messenger (verification)', () => {
  it('echoes hub.challenge as plain text (200) when mode=subscribe and token matches', () => {
    const { controller } = makeController({});
    const reply = makeReply();

    controller.verifyWebhook(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'CHALLENGE-STRING-ABC',
      },
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    const afterStatus = (reply.status as jest.Mock).mock.results[0].value;
    expect(afterStatus.type).toHaveBeenCalledWith('text/plain');
    const afterType = afterStatus.type.mock.results[0].value;
    expect(afterType.send).toHaveBeenCalledWith('CHALLENGE-STRING-ABC');
  });

  it('returns 403 when hub.verify_token does not match', () => {
    const { controller } = makeController({});
    const reply = makeReply();

    controller.verifyWebhook(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'CHALLENGE',
      },
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 when hub.mode is not subscribe', () => {
    const { controller } = makeController({});
    const reply = makeReply();

    controller.verifyWebhook(
      {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'CHALLENGE',
      },
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 when MESSENGER_VERIFY_TOKEN is not configured', () => {
    // Pass null to explicitly omit the env var from the config stub
    const { controller } = makeController({ verifyToken: null });
    const reply = makeReply();

    controller.verifyWebhook(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'CHALLENGE',
      },
      reply,
    );

    // verifyToken is undefined → the condition fails → 403
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// POST /webhook/messenger — inbound events
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — POST /webhook/messenger', () => {
  it('returns { status: ok } for a valid page event', () => {
    const { controller } = makeController({});
    const req = makeBody() as unknown as FastifyRequest;
    const result = controller.handleWebhook(req);
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns 200/ok and ignores a non-page object (does not enqueue)', () => {
    const { controller, debounce } = makeController({});
    const req = makeBody({}, 'not_page') as unknown as FastifyRequest;
    const result = controller.handleWebhook(req);
    expect(result).toEqual({ status: 'ok' });
    expect(debounce.enqueue).not.toHaveBeenCalled();
  });

  it('returns ok and ignores a malformed body (parse failure)', () => {
    const { controller, debounce } = makeController({});
    const req = {
      body: { object: 'page', entry: 'NOT_AN_ARRAY' },
    } as unknown as FastifyRequest;
    const result = controller.handleWebhook(req);
    expect(result).toEqual({ status: 'ok' });
    expect(debounce.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a message to DebounceService with the PSID as the key', () => {
    const { controller, debounce } = makeController({});
    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    expect(debounce.enqueue).toHaveBeenCalledWith(
      'PSID-1',
      expect.objectContaining({
        contactId: 'PSID-1',
        text: 'مرحبا',
        channel: 'messenger',
      }),
      expect.any(Function),
    );
  });

  it('maps externalMessageId from mid', () => {
    const { controller, debounce } = makeController({});
    const req = makeBody({
      message: { mid: 'UNIQUE-MID-XYZ', text: 'hello' },
    }) as unknown as FastifyRequest;
    controller.handleWebhook(req);
    expect(debounce.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ externalMessageId: 'UNIQUE-MID-XYZ' }),
      expect.any(Function),
    );
  });

  it('enqueues all messaging events across multiple entries', () => {
    const { controller, debounce } = makeController({});
    const req = {
      body: {
        object: 'page',
        entry: [
          {
            id: 'PAGE-1',
            time: Date.now(),
            messaging: [
              {
                sender: { id: 'PSID-A' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'mid-a', text: 'hello A' },
              },
            ],
          },
          {
            id: 'PAGE-1',
            time: Date.now(),
            messaging: [
              {
                sender: { id: 'PSID-B' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'mid-b', text: 'hello B' },
              },
            ],
          },
        ],
      },
    } as unknown as FastifyRequest;

    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledTimes(2);
  });

  it('dedupes messaging events with the same mid within a single POST', () => {
    const { controller, debounce } = makeController({});
    const req = {
      body: {
        object: 'page',
        entry: [
          {
            id: 'PAGE-1',
            time: Date.now(),
            messaging: [
              {
                sender: { id: 'PSID-A' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'SAME-MID', text: 'first' },
              },
              {
                sender: { id: 'PSID-A' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'SAME-MID', text: 'second (dup)' },
              },
            ],
          },
        ],
      },
    } as unknown as FastifyRequest;

    controller.handleWebhook(req);

    // Duplicate mid → enqueued only once
    expect(debounce.enqueue).toHaveBeenCalledTimes(1);
  });

  it('dedupes the same mid across different entries in a single POST (seen is per-request)', () => {
    // Fix 3: seen is hoisted above the entry loop so a mid appearing in
    // entry[0] and entry[1] of the same POST is only enqueued once.
    const { controller, debounce } = makeController({});
    const req = {
      body: {
        object: 'page',
        entry: [
          {
            id: 'PAGE-1',
            time: Date.now(),
            messaging: [
              {
                sender: { id: 'PSID-A' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'CROSS-ENTRY-MID', text: 'first entry' },
              },
            ],
          },
          {
            id: 'PAGE-1',
            time: Date.now(),
            messaging: [
              {
                sender: { id: 'PSID-A' },
                recipient: { id: 'PAGE-1' },
                timestamp: Date.now(),
                message: { mid: 'CROSS-ENTRY-MID', text: 'second entry (dup)' },
              },
            ],
          },
        ],
      },
    } as unknown as FastifyRequest;

    controller.handleWebhook(req);

    // Same mid across entries → only one enqueue
    expect(debounce.enqueue).toHaveBeenCalledTimes(1);
  });

  it('maps referral.ref → adRef in the enqueued IncomingMessage', () => {
    const { controller, debounce } = makeController({});
    const req = {
      body: {
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
                  mid: 'mid-ref',
                  text: 'مرحبا',
                  referral: { ref: 'summer-ad-2024' },
                },
              },
            ],
          },
        ],
      },
    } as unknown as FastifyRequest;

    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledWith(
      'PSID-1',
      expect.objectContaining({ adRef: 'summer-ad-2024' }),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// Async worker (processBatch)
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — async processBatch worker', () => {
  it('sends mark_seen, then typing_on, then reply text, then typing_off when ran=true', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: { reply: 'أهلاً', ran: true, aiState: 'bot' },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    const senderActions = (
      messengerClient.senderAction as jest.Mock
    ).mock.calls.map((c: unknown[]) => c[1]);
    expect(senderActions).toContain('mark_seen');
    expect(senderActions).toContain('typing_on');
    expect(senderActions).toContain('typing_off');
    expect(messengerClient.sendText).toHaveBeenCalledWith('PSID-1', 'أهلاً');
  });

  it('splits a multi-paragraph reply into separate message bubbles, in order', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: {
        reply: 'أهلاً وسهلاً\n\nبتدوري على لون معيّن؟\n\nعندنا أحمر وأسود',
        ran: true,
        aiState: 'bot',
      },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendText).toHaveBeenCalledTimes(3);
    expect(messengerClient.sendText).toHaveBeenNthCalledWith(
      1,
      'PSID-1',
      'أهلاً وسهلاً',
    );
    expect(messengerClient.sendText).toHaveBeenNthCalledWith(
      2,
      'PSID-1',
      'بتدوري على لون معيّن؟',
    );
    expect(messengerClient.sendText).toHaveBeenNthCalledWith(
      3,
      'PSID-1',
      'عندنا أحمر وأسود',
    );
    // Each bubble is preceded by its own typing_on (one per bubble).
    const typingOns = (
      messengerClient.senderAction as jest.Mock
    ).mock.calls.filter((c: unknown[]) => c[1] === 'typing_on');
    expect(typingOns.length).toBeGreaterThanOrEqual(3);
  });

  it('sends the whole reply as one message when pacing is disabled', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: { reply: 'سطر أول\n\nسطر ثاني', ran: true, aiState: 'bot' },
      pacingEnabled: false,
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendText).toHaveBeenCalledTimes(1);
    expect(messengerClient.sendText).toHaveBeenCalledWith(
      'PSID-1',
      'سطر أول\n\nسطر ثاني',
    );
  });

  it('does NOT call sendText when ran=false (ai_state is not bot)', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: { reply: '', ran: false, aiState: 'human' },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendText).not.toHaveBeenCalled();
  });

  it('sends a product carousel when products are present and ran=true', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
        ran: true,
        aiState: 'bot',
      },
      media: { p1: [{ url: 'https://cdn/p1.jpg', type: 'image' }] },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendTemplate).toHaveBeenCalledWith(
      'PSID-1',
      expect.arrayContaining([
        expect.objectContaining({ title: 'عباية', subtitle: '45.000 د.أ' }),
      ]),
    );
  });

  it('leaves a card image-less when getMedia throws (best-effort per-product)', async () => {
    const { controller, products, messengerClient, flush } = makeController({
      reply: {
        reply: 'خيارات',
        products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
        ran: true,
        aiState: 'bot',
      },
    });
    (products.getMedia as jest.Mock).mockRejectedValue(
      new Error('storage down'),
    );

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    // sendTemplate is still called (best-effort) even when getMedia fails;
    // the card just has no image_url — assert an actual behaviour, not a no-op.
    expect(messengerClient.sendTemplate).toHaveBeenCalledWith(
      'PSID-1',
      expect.arrayContaining([
        expect.objectContaining({ title: 'عباية', subtitle: '45.000 د.أ' }),
      ]),
    );
    const [[, elements]] = (messengerClient.sendTemplate as jest.Mock).mock
      .calls;
    expect(
      (elements as Array<{ image_url?: string }>)[0].image_url,
    ).toBeUndefined();
  });

  it('sends each product photo as its own image message when reply.images is present', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: {
        reply: 'تفضلي صور العباية',
        images: ['https://pub.r2.dev/a.jpeg', 'https://pub.r2.dev/b.jpeg'],
        ran: true,
        aiState: 'bot',
      },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendImage).toHaveBeenCalledTimes(2);
    expect(messengerClient.sendImage).toHaveBeenNthCalledWith(
      1,
      'PSID-1',
      'https://pub.r2.dev/a.jpeg',
    );
    expect(messengerClient.sendImage).toHaveBeenNthCalledWith(
      2,
      'PSID-1',
      'https://pub.r2.dev/b.jpeg',
    );
  });

  it('does NOT call sendImage when reply.images is absent', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: { reply: 'أهلاً', ran: true, aiState: 'bot' },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendImage).not.toHaveBeenCalled();
  });

  it('keeps sending the remaining photos when one sendImage fails (per-image best-effort)', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: {
        reply: 'صور',
        images: ['https://pub.r2.dev/a.jpeg', 'https://pub.r2.dev/b.jpeg'],
        ran: true,
        aiState: 'bot',
      },
    });
    (messengerClient.sendImage as jest.Mock)
      .mockRejectedValueOnce(new Error('image 1 down'))
      .mockResolvedValueOnce(undefined);

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    // The turn must not reject even though one image send failed.
    await expect(flush()).resolves.toBeUndefined();

    expect(messengerClient.sendImage).toHaveBeenCalledTimes(2);
  });

  it('sends the fallback Arabic text when the agent throws', async () => {
    const { controller, messengerClient, flush } = makeController({
      agentThrows: true,
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    expect(messengerClient.sendText).toHaveBeenCalledWith(
      'PSID-1',
      expect.stringContaining('لحظة'),
    );
  });

  it('does not throw when both the agent and the fallback send fail', async () => {
    const { controller, messengerClient, flush } = makeController({
      agentThrows: true,
    });
    (messengerClient.sendText as jest.Mock).mockRejectedValue(
      new Error('Messenger down'),
    );

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);

    await expect(flush()).resolves.not.toThrow();
  });

  it('choreography: mark_seen precedes typing_on, typing_on precedes typing_off', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: { reply: 'أهلاً', ran: true, aiState: 'bot' },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    const calls = (messengerClient.senderAction as jest.Mock).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    const markIdx = calls.indexOf('mark_seen');
    const onIdx = calls.indexOf('typing_on');
    const offIdx = calls.indexOf('typing_off');
    expect(markIdx).toBeGreaterThanOrEqual(0);
    expect(onIdx).toBeGreaterThan(markIdx);
    expect(offIdx).toBeGreaterThan(onIdx);
  });

  it('sends overflow note as text when productOverflow > 0 but no products returned', async () => {
    const { controller, messengerClient, flush } = makeController({
      reply: {
        reply: 'خيارات',
        // no products array — only an overflow count (edge case in controller line 235)
        productOverflow: 5,
        ran: true,
        aiState: 'bot',
      },
    });

    const req = makeBody() as unknown as FastifyRequest;
    controller.handleWebhook(req);
    await flush();

    // sendTemplate is NOT called (no products), but an overflow note text IS sent.
    expect(messengerClient.sendTemplate).not.toHaveBeenCalled();
    const textCalls = (messengerClient.sendText as jest.Mock).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    const overflowText = textCalls.find(
      (t) => t.includes('5') && t.includes('تصميم'),
    );
    expect(overflowText).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /webhook/messenger — voice-note gate (TRANSCRIPTION_ENABLED)
// ---------------------------------------------------------------------------

describe('MessengerWebhookController — voice-note gate', () => {
  const AUDIO_ATTACHMENT = {
    type: 'audio',
    payload: { url: 'https://cdn.fb.com/voice.mp4' },
  };

  it('flag OFF (default): a voice-only event is skipped exactly like today', () => {
    const { controller, debounce } = makeController({});

    const req = makeBody({
      message: { mid: 'mid-a', attachments: [AUDIO_ATTACHMENT] },
    }) as unknown as FastifyRequest;
    const result = controller.handleWebhook(req);

    expect(result).toEqual({ status: 'ok' });
    expect(debounce.enqueue).not.toHaveBeenCalled();
  });

  it('flag OFF: a voice-only event carrying a referral still persists attribution', async () => {
    const { controller, conversations, debounce } = makeController({});

    const req = makeBody({
      message: {
        mid: 'mid-a',
        attachments: [AUDIO_ATTACHMENT],
        referral: { ref: 'spring-ad-1', source: 'ADS', type: 'OPEN_THREAD' },
      },
    }) as unknown as FastifyRequest;
    controller.handleWebhook(req);
    // persistAttributionOnly is fire-and-forget — let the microtask run.
    await new Promise((r) => setImmediate(r));

    expect(debounce.enqueue).not.toHaveBeenCalled();
    expect(conversations.recordFirstTouchAttribution).toHaveBeenCalledWith(
      'conv-stub',
      expect.objectContaining({ adRef: 'spring-ad-1' }),
    );
  });

  it('flag OFF: audio is stripped from a mixed text+voice event, text still flows', () => {
    const { controller, debounce } = makeController({});

    const req = makeBody({
      message: {
        mid: 'mid-a',
        text: 'مرحبا',
        attachments: [AUDIO_ATTACHMENT],
      },
    }) as unknown as FastifyRequest;
    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledTimes(1);
    const incoming = (debounce.enqueue as jest.Mock).mock.calls[0][1] as {
      text: string;
      lastAudioUrl?: string;
    };
    expect(incoming.text).toBe('مرحبا');
    expect(incoming.lastAudioUrl).toBeUndefined();
  });

  it('flag ON: a voice-only event is enqueued with lastAudioUrl', () => {
    const { controller, debounce } = makeController({
      transcriptionEnabled: true,
    });

    const req = makeBody({
      message: { mid: 'mid-a', attachments: [AUDIO_ATTACHMENT] },
    }) as unknown as FastifyRequest;
    controller.handleWebhook(req);

    expect(debounce.enqueue).toHaveBeenCalledTimes(1);
    const incoming = (debounce.enqueue as jest.Mock).mock.calls[0][1] as {
      text: string;
      lastAudioUrl?: string;
      externalMessageId?: string;
    };
    expect(incoming.lastAudioUrl).toBe('https://cdn.fb.com/voice.mp4');
    expect(incoming.text).toBe('');
    expect(incoming.externalMessageId).toBe('mid-a');
  });
});
