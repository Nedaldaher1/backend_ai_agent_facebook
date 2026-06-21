/**
 * Focused unit tests for AgentService idempotency / dedup-key derivation.
 *
 * Tests the observable behaviour of handleMessage via the
 * ConversationsService.findMessageByExternalId stub:
 *  (a) externalMessageId is forwarded verbatim as the dedup key.
 *  (b) Two turns with the SAME contact whose text differs only by whitespace
 *      or case produce the SAME dedup key inside the 10-second window,
 *      so the second is treated as a duplicate → empty reply, generate NOT called.
 *  (c) The same content in a LATER 10-second window produces a DIFFERENT key
 *      → processed normally.
 *
 * Strategy: same mocks as agent.service.spec.ts (identical jest.mock calls
 * at the top of this file), Jest fake timers to control the 10 s window.
 * No real DB, no real Claude.
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

import { AgentService } from '../agent.service';
import { buildMastra } from '../mastra/mastra.factory';
import type { ConfigService } from '@nestjs/config';
import type { ProductsService } from '@/modules/products/products.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { AgentBehaviorService } from '../agent-behavior.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import type { VisionService } from '../vision/vision.service';

const mockBuildMastra = buildMastra as jest.MockedFunction<typeof buildMastra>;

// ---------------------------------------------------------------------------
// Shared fakes (identical pattern to agent.service.spec.ts)
// ---------------------------------------------------------------------------

const fakeSalesAgent = { generate: jest.fn() };

function makeConfigMock(): ConfigService {
  return { getOrThrow: () => 'postgres://x' } as unknown as ConfigService;
}

const productsMock = {} as unknown as ProductsService;
const ordersMock = {} as unknown as OrdersService;
const agentBehaviorMock = {
  getInstructions: jest.fn().mockResolvedValue('x'),
} as unknown as AgentBehaviorService;
const knowledgeMock = {} as unknown as KnowledgeService;
const sizingMock = { recommendSize: jest.fn() } as unknown as SizingService;
const visionMock = {
  extractAttributes: jest.fn().mockResolvedValue({ attributes: null, confidence: null }),
} as unknown as VisionService;

/**
 * Builds a ConversationsService stub where findMessageByExternalId starts
 * returning undefined (not a duplicate). Tests mutate the mock per scenario.
 */
function makeConversations(conversationId = 'convo-dedup'): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({ id: conversationId, state: null }),
    addMessage: jest.fn().mockResolvedValue({}),
    findMessageByExternalId: jest.fn().mockResolvedValue(undefined), // not a dup by default
  } as unknown as ConversationsService;
}

function buildService(conversations: ConversationsService): AgentService {
  const svc = new AgentService(
    makeConfigMock(),
    productsMock,
    conversations,
    ordersMock,
    agentBehaviorMock,
    knowledgeMock,
    sizingMock,
    visionMock,
  );
  svc.onModuleInit();
  return svc;
}

// ---------------------------------------------------------------------------

describe('AgentService — idempotency / dedup-key derivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Set a baseline time inside a stable 10-second window (window index = 1000).
    jest.setSystemTime(10_000_000); // ms → 10 000 000 / 10 000 = window 1000

    fakeSalesAgent.generate.mockResolvedValue({ text: 'أهلاً' });
    mockBuildMastra.mockReturnValue({
      mastra: {} as ReturnType<typeof buildMastra>['mastra'],
      salesAgent: fakeSalesAgent as unknown as ReturnType<typeof buildMastra>['salesAgent'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // (a) externalMessageId used verbatim
  // -------------------------------------------------------------------------

  it('passes the provided externalMessageId verbatim to findMessageByExternalId', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    await svc.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      externalMessageId: 'provider-id-xyz',
    });

    expect(conversations.findMessageByExternalId).toHaveBeenCalledWith(
      'convo-dedup',
      'provider-id-xyz',
    );
  });

  it('uses the externalMessageId as the externalId written to addMessage', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    await svc.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      externalMessageId: 'explicit-mid',
    });

    const addMessage = conversations.addMessage as jest.Mock;
    const inboundCall = addMessage.mock.calls[0][0];
    expect(inboundCall.externalId).toBe('explicit-mid');
  });

  // -------------------------------------------------------------------------
  // (b) Same text (modulo whitespace/case) → same dedup key → second is dup
  // -------------------------------------------------------------------------

  it('treats a second turn as a duplicate when text differs only by trailing whitespace', async () => {
    // First call: not a dup (mock returns undefined by default).
    const conversations = makeConversations();
    const svc = buildService(conversations);

    // Capture the dedup key from the first call.
    let capturedKey: string | undefined;
    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_convoId: string, key: string) => {
        capturedKey = key;
        return Promise.resolve(undefined); // first call → not a dup
      },
    );

    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا   ' }); // trailing spaces

    // Second call: same contact, same text with leading whitespace — expect same key.
    // Simulate a dup by returning a message row for that key.
    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_convoId: string, key: string) => {
        // The key must match the first call's key.
        expect(key).toBe(capturedKey);
        return Promise.resolve({ id: 'existing-msg' });
      },
    );

    const result = await svc.handleMessage({ contactId: 'C1', text: '   مرحبا' }); // leading spaces

    expect(result.reply).toBe('');
    // generate was called for the FIRST turn only — not for the second.
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
  });

  it('treats a second turn as a duplicate when text differs only by internal whitespace', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    let capturedKey: string | undefined;
    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_: string, key: string) => {
        capturedKey = key;
        return Promise.resolve(undefined);
      },
    );

    await svc.handleMessage({ contactId: 'C1', text: 'بدي  عباية' }); // double space

    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_: string, key: string) => {
        expect(key).toBe(capturedKey);
        return Promise.resolve({ id: 'existing' });
      },
    );

    const result = await svc.handleMessage({ contactId: 'C1', text: 'بدي عباية' }); // single space

    expect(result.reply).toBe('');
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
  });

  it('treats a second turn as a duplicate when text differs only by case (ASCII)', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    let capturedKey: string | undefined;
    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_: string, key: string) => {
        capturedKey = key;
        return Promise.resolve(undefined);
      },
    );

    await svc.handleMessage({ contactId: 'C1', text: 'Hello' });

    (conversations.findMessageByExternalId as jest.Mock).mockImplementationOnce(
      (_: string, key: string) => {
        expect(key).toBe(capturedKey);
        return Promise.resolve({ id: 'existing' });
      },
    );

    const result = await svc.handleMessage({ contactId: 'C1', text: 'hello' });

    expect(result.reply).toBe('');
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
  });

  it('does NOT call addMessage when a duplicate is detected', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    // First call — not a dup.
    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });
    (conversations.findMessageByExternalId as jest.Mock).mockResolvedValue({ id: 'existing' });

    // Second call — dup.
    const addCallsBefore = (conversations.addMessage as jest.Mock).mock.calls.length;
    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });
    const addCallsAfter = (conversations.addMessage as jest.Mock).mock.calls.length;

    // No new addMessage calls for the duplicate turn.
    expect(addCallsAfter).toBe(addCallsBefore);
  });

  // -------------------------------------------------------------------------
  // (c) Same content in a LATER 10-second window → different key → processed
  // -------------------------------------------------------------------------

  it('processes the same text normally when more than 10 seconds have passed', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    // First call at t=10 000 000 ms (window 1000).
    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    // Advance time by 10 001 ms → new window (1001).
    jest.advanceTimersByTime(10_001);

    // Second call in the new window — always returns undefined (not a dup).
    const result = await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    // Both calls must have gone through generate().
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('أهلاً');
  });

  it('produces a different dedup key after crossing the 10-second boundary', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    const keys: string[] = [];
    (conversations.findMessageByExternalId as jest.Mock).mockImplementation(
      (_: string, key: string) => {
        keys.push(key);
        return Promise.resolve(undefined);
      },
    );

    // Turn 1 at window 1000
    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    // Advance into window 1001
    jest.advanceTimersByTime(10_001);

    // Turn 2 at window 1001
    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  // -------------------------------------------------------------------------
  // Hash key format
  // -------------------------------------------------------------------------

  it('content-hash dedup keys start with "h:" prefix', async () => {
    const conversations = makeConversations();
    const svc = buildService(conversations);

    let capturedKey: string | undefined;
    (conversations.findMessageByExternalId as jest.Mock).mockImplementation(
      (_: string, key: string) => {
        capturedKey = key;
        return Promise.resolve(undefined);
      },
    );

    await svc.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(capturedKey).toMatch(/^h:[0-9a-f]{40}$/);
  });
});
