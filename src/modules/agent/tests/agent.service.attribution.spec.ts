/**
 * Unit tests for AgentService — WS3 first-touch attribution.
 *
 * Covers:
 *  1. handleMessage with input.referral calls recordFirstTouchAttribution.
 *  2. handleMessage without input.referral does NOT call recordFirstTouchAttribution.
 *  3. Attribution failure (recordFirstTouchAttribution throws) never breaks the reply.
 *  4. Product resolution: when recordFirstTouchAttribution returns a row and
 *     adProductId is present, findPublishedBySku is called (publish gate).
 *  5. Product resolution: on a SKU match, mergeState is called with adProduct.
 *  6. Product resolution: on no SKU match (undefined), mergeState is NOT called.
 *  7. Attribution idempotency: when recordFirstTouchAttribution returns undefined
 *     (already attributed), findPublishedBySku is NOT called.
 *
 * Strategy: same mock pattern as agent.service.spec.ts — factory is mocked,
 * no real Anthropic call or Postgres connection.
 */

jest.mock('../mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
jest.mock('@mastra/core/di', () => {
  const MockRequestContext = jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    get: jest.fn(),
  }));
  return { RequestContext: MockRequestContext };
});

import { AgentService, type IncomingMessage } from '../agent.service';
import { buildMastra } from '../mastra/mastra.factory';
import type { ConfigService } from '@nestjs/config';
import type { ProductsService } from '@/modules/products/products.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { AgentBehaviorService } from '../agent-behavior.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import type { VisionService } from '../vision/vision.service';
import type { TranscriptionService } from '../transcription/transcription.service';
import type { TriageService } from '../triage/triage.service';

const mockBuildMastra = buildMastra as jest.MockedFunction<typeof buildMastra>;

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeConfigMock(): ConfigService {
  return {
    getOrThrow: () => 'postgres://x',
    get: () => undefined, // MASTRA_LOG_LEVEL → falls back to 'info'
  } as unknown as ConfigService;
}

const agentBehaviorMock: AgentBehaviorService = {
  getInstructions: jest.fn().mockResolvedValue('x'),
} as unknown as AgentBehaviorService;

const ordersMock = {} as unknown as OrdersService;
const knowledgeMock = {} as unknown as KnowledgeService;
const sizingMock = { recommendSize: jest.fn() } as unknown as SizingService;
const visionMock: VisionService = {
  extractAttributes: jest
    .fn()
    .mockResolvedValue({ attributes: null, confidence: null }),
} as unknown as VisionService;

/** Transcription pre-step disabled in unit tests (opt-in via TRANSCRIPTION_ENABLED). */
const transcriptionMock = {
  transcribe: jest.fn().mockResolvedValue({
    ok: false,
    transcript: null,
    confidence: null,
    reason: 'disabled',
    meta: { model: 'test', latencyMs: 0 },
  }),
} as unknown as TranscriptionService;

/** Triage tier disabled in unit tests (opt-in via TRIAGE_ENABLED). */
const triageMock = {
  enabled: false,
  match: () => null,
} as unknown as TriageService;

const FAKE_REPLY = 'أهلاً';

function makeProductsMock(skuProduct?: object | null): ProductsService {
  return {
    search: jest.fn().mockResolvedValue([]),
    findPublishedBySku: jest.fn().mockResolvedValue(skuProduct ?? undefined),
  } as unknown as ProductsService;
}

const ALREADY_ATTRIBUTED = Symbol('already-attributed');

function makeConversationsMock(opts?: {
  /**
   * Pass ALREADY_ATTRIBUTED to make recordFirstTouchAttribution return undefined
   * (simulating the already-attributed idempotent no-op). Omit or pass an
   * object to get the updated row on the first touch (default).
   */
  attributionResult?: typeof ALREADY_ATTRIBUTED | object;
  conversationId?: string;
}): ConversationsService {
  const conversationId = opts?.conversationId ?? 'conv-1';
  const attributionResult =
    opts?.attributionResult === ALREADY_ATTRIBUTED
      ? undefined
      : (opts?.attributionResult ?? {
          id: conversationId,
          attributedAt: new Date(),
        });

  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({
      id: conversationId,
      aiState: 'bot',
      humanSummary: null,
      pausedUntil: null,
    }),
    addMessage: jest.fn().mockResolvedValue({}),
    findMessageByExternalId: jest.fn().mockResolvedValue(undefined),
    clearHumanSummary: jest.fn().mockResolvedValue(undefined),
    setAiState: jest.fn().mockResolvedValue({}),
    recordEvent: jest.fn().mockResolvedValue({}),
    recordFirstTouchAttribution: jest.fn().mockResolvedValue(attributionResult),
    mergeState: jest.fn().mockResolvedValue({}),
  } as unknown as ConversationsService;
}

function makeService(
  conversations: ConversationsService,
  products: ProductsService,
): AgentService {
  const fakeSalesAgent = {
    generate: jest.fn().mockResolvedValue({ text: FAKE_REPLY }),
  };
  mockBuildMastra.mockReturnValue({
    mastra: {} as ReturnType<typeof buildMastra>['mastra'],
    salesAgent: fakeSalesAgent as unknown as ReturnType<
      typeof buildMastra
    >['salesAgent'],
  });
  const svc = new AgentService(
    makeConfigMock(),
    products,
    conversations,
    ordersMock,
    agentBehaviorMock,
    knowledgeMock,
    sizingMock,
    visionMock,
    transcriptionMock,
    triageMock,
  );
  svc.onModuleInit();
  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService — WS3 first-touch attribution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls recordFirstTouchAttribution when input.referral is present', async () => {
    const conversations = makeConversationsMock();
    const products = makeProductsMock();
    const svc = makeService(conversations, products);

    const input: IncomingMessage = {
      contactId: 'PSID-1',
      text: 'مرحبا',
      referral: { ref: 'summer-ad', adId: 'ad_999', adSource: 'ADS' },
    };
    const reply = await svc.handleMessage(input);

    // Give the fire-and-forget void attribution a tick to settle.
    await Promise.resolve();

    expect(conversations.recordFirstTouchAttribution).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        adRef: 'summer-ad',
        adId: 'ad_999',
        adSource: 'ADS',
      }),
    );
    // The reply is still returned even though attribution is async.
    expect(reply.reply).toBe(FAKE_REPLY);
    expect(reply.ran).toBe(true);
  });

  it('does NOT call recordFirstTouchAttribution when input.referral is absent', async () => {
    const conversations = makeConversationsMock();
    const products = makeProductsMock();
    const svc = makeService(conversations, products);

    await svc.handleMessage({ contactId: 'PSID-2', text: 'مرحبا' });
    await Promise.resolve();

    expect(conversations.recordFirstTouchAttribution).not.toHaveBeenCalled();
  });

  it('never breaks the reply when recordFirstTouchAttribution throws', async () => {
    const conversations = makeConversationsMock();
    (conversations.recordFirstTouchAttribution as jest.Mock).mockRejectedValue(
      new Error('DB down'),
    );
    const products = makeProductsMock();
    const svc = makeService(conversations, products);

    const reply = await svc.handleMessage({
      contactId: 'PSID-3',
      text: 'مرحبا',
      referral: { ref: 'some-ref' },
    });
    // Let the background task settle.
    await new Promise((r) => setTimeout(r, 10));

    // Reply must still be returned despite attribution failure.
    expect(reply.reply).toBe(FAKE_REPLY);
    expect(reply.ran).toBe(true);
  });

  it('calls findPublishedBySku with adProductId when attribution succeeds and adProductId is present', async () => {
    const conversations = makeConversationsMock();
    const products = makeProductsMock(undefined); // no match — tests the call, not the merge
    const svc = makeService(conversations, products);

    await svc.handleMessage({
      contactId: 'PSID-4',
      text: 'مرحبا',
      referral: { adProductId: 'SKU-99' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(products.findPublishedBySku).toHaveBeenCalledWith('SKU-99');
  });

  it('calls mergeState with adProduct when a published product matches the SKU', async () => {
    const matchedProduct = {
      id: 'prod-uuid',
      name: 'عباية سوداء',
      priceJod: '45.000',
    };
    const conversations = makeConversationsMock();
    const products = makeProductsMock(matchedProduct);
    const svc = makeService(conversations, products);

    await svc.handleMessage({
      contactId: 'PSID-5',
      text: 'مرحبا',
      referral: { adProductId: 'sku-black' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(conversations.mergeState).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        adProduct: expect.objectContaining({
          id: 'prod-uuid',
          name: 'عباية سوداء',
          priceJod: '45.000',
        }),
      }),
    );
  });

  it('does NOT call mergeState when the SKU does not match any published product', async () => {
    const conversations = makeConversationsMock();
    const products = makeProductsMock(undefined); // no match
    const svc = makeService(conversations, products);

    await svc.handleMessage({
      contactId: 'PSID-6',
      text: 'مرحبا',
      referral: { adProductId: 'sku-nonexistent' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(conversations.mergeState).not.toHaveBeenCalled();
  });

  it('does NOT call findPublishedBySku when recordFirstTouchAttribution returns undefined (already attributed)', async () => {
    // Simulate already-attributed: recordFirstTouchAttribution returns undefined.
    const conversations = makeConversationsMock({
      attributionResult: ALREADY_ATTRIBUTED,
    });
    const products = makeProductsMock({
      id: 'p1',
      name: 'x',
      priceJod: '10.000',
    });
    const svc = makeService(conversations, products);

    await svc.handleMessage({
      contactId: 'PSID-7',
      text: 'مرحبا',
      referral: { adProductId: 'sku-abc' },
    });
    await new Promise((r) => setTimeout(r, 10));

    // recordFirstTouchAttribution returned undefined → stop; SKU lookup skipped.
    expect(products.findPublishedBySku).not.toHaveBeenCalled();
  });

  it('does NOT call findPublishedBySku when referral has no adProductId', async () => {
    const conversations = makeConversationsMock();
    const products = makeProductsMock({
      id: 'p2',
      name: 'y',
      priceJod: '20.000',
    });
    const svc = makeService(conversations, products);

    await svc.handleMessage({
      contactId: 'PSID-8',
      text: 'مرحبا',
      referral: { ref: 'some-ref', adId: 'ad_111' }, // no adProductId
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(products.findPublishedBySku).not.toHaveBeenCalled();
  });
});
