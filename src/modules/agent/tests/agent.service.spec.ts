/**
 * Unit tests for AgentService — AIA-27 (handleMessage + memory scoping).
 *
 * Strategy: mock the factory module so no real Anthropic API call or
 * Postgres connection is made. The mock returns a salesAgent whose
 * `generate` is a jest.fn() that resolves immediately with a fixed result.
 *
 * Test coverage:
 *  1. `onModuleInit` calls `buildMastra` with connectionString + agentBehavior.
 *  2. `handleMessage` derives resourceId/threadId correctly and passes the right
 *     memory shape to salesAgent.generate.
 *  3. `findOrCreateByPsid` is called with the correct arguments.
 *  4. The RequestContext carries the required identity keys.
 *  5. Isolation: two consecutive calls with different contactIds produce
 *     different memory.resource scopes.
 *  6. Both addMessage calls (inbound + outbound) happen on every turn.
 *  7. The reply equals the generate result text.
 *  8. Products are extracted and deduped from search_products toolResults.
 *  9. When toolResults is absent, products is undefined.
 * 10. Bot-pause gate: when aiState !== 'bot' (human/paused), generate is NOT called,
 *     addMessage is called once (inbound only), and reply === ''.
 * 11. aiState === 'bot' proceeds normally through generate().
 */

// Mock the factory BEFORE any import of AgentService so the module-level
// `jest.mock` hoisting fires at the right time. Use an EXPLICIT factory (not
// automock) so Jest never loads the real mastra.factory.ts — automock would
// require the real module, pulling in @mastra/core whose ESM-only deps cannot
// be required under Jest (CJS).
jest.mock('../mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));

// vision.service.ts (imported transitively via agent.service.ts) imports the real
// @mastra/core/agent, whose ESM-only deps cannot be required under Jest (CJS).
// Stub it so the module graph loads; VisionService itself is stubbed per test.
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));

// flydrive is ESM-only and isolated inside StorageService; AgentService imports
// ProductsService, which transitively imports the products -> storage chain.
// Stub flydrive so requiring that chain doesn't load the real ESM module under
// Jest (CJS) — same pattern as products.service.spec.ts.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

// RequestContext is used by AgentService.handleMessage. We mock @mastra/core/di
// so Jest doesn't load the real ESM module. The mock provides a minimal
// implementation that lets us assert requestContext.set() was called with the
// right values.
jest.mock('@mastra/core/di', () => {
  const instances: Array<{ sets: Map<string, unknown> }> = [];
  const MockRequestContext = jest.fn().mockImplementation(() => {
    const sets = new Map<string, unknown>();
    const instance = {
      sets,
      set: jest.fn((key: string, val: unknown) => sets.set(key, val)),
      get: jest.fn((key: string) => sets.get(key)),
    };
    instances.push(instance);
    return instance;
  });
  // Expose instances for test assertions.
  (MockRequestContext as { instances: typeof instances }).instances = instances;
  return { RequestContext: MockRequestContext };
});

import { AgentService } from '../agent.service';
import { buildMastra } from '../mastra/mastra.factory';
import { RequestContext } from '@mastra/core/di';
import type { ConfigService } from '@nestjs/config';
import type { ProductsService } from '@/modules/products/products.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { AgentBehaviorService } from '../agent-behavior.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import type { VisionService } from '../vision/vision.service';
import type { ManyChatControlService } from '../manychat/manychat-control.service';

// ---------------------------------------------------------------------------
// Typed cast helpers
// ---------------------------------------------------------------------------

const mockBuildMastra = buildMastra as jest.MockedFunction<typeof buildMastra>;
const MockRequestContextCtor = RequestContext as unknown as jest.MockedClass<
  typeof RequestContext
> & { instances: Array<{ sets: Map<string, unknown>; set: jest.Mock; get: jest.Mock }> };

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

/** A fake ConfigService that returns the given DATABASE_URL. */
function makeConfigMock(url = 'postgres://x'): ConfigService {
  return { getOrThrow: () => url } as unknown as ConfigService;
}

/** A minimal ProductsService stub. */
const productsMock = {} as unknown as ProductsService;

/** A minimal OrdersService stub. */
const ordersMock = {} as unknown as OrdersService;

/** A minimal AgentBehaviorService stub. */
const agentBehaviorMock = {
  getInstructions: jest.fn().mockResolvedValue('x'),
} as unknown as AgentBehaviorService;

/** A minimal KnowledgeService stub. */
const knowledgeMock = {} as unknown as KnowledgeService;

/** A minimal SizingService stub. */
const sizingMock = { recommendSize: jest.fn() } as unknown as SizingService;

/**
 * A minimal VisionService stub. Default: no attributes (the image pre-step is a
 * no-op), so the existing turn tests are unaffected. Image-specific tests
 * override extractAttributes per case.
 */
const visionMock = {
  extractAttributes: jest
    .fn()
    .mockResolvedValue({ attributes: null, confidence: null }),
} as unknown as VisionService;

/** A minimal ManyChatControlService stub. */
const manychatControlMock = {
  applyState: jest.fn().mockResolvedValue(undefined),
} as unknown as ManyChatControlService;

/**
 * A ConversationsService stub with findOrCreateByPsid and addMessage.
 * Both resolve immediately; addMessage call order is asserted in the tests.
 *
 * @param conversationId  The id returned by findOrCreateByPsid (default 'convo-1').
 * @param aiState         The ai_state column value on the conversation row (default 'bot').
 *                        Pass 'human' or 'paused' to exercise the pause gate.
 */
function makeConversationsMock(
  conversationId = 'convo-1',
  aiState: string = 'bot',
): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({ id: conversationId, aiState }),
    addMessage: jest.fn().mockResolvedValue({}),
    // Default: no prior message with this idempotency key (not a duplicate).
    findMessageByExternalId: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversationsService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService', () => {
  const FAKE_REPLY = 'مرحبا! كيف بقدر أساعدك؟';

  /** A minimal fake salesAgent with a mocked `generate`. */
  const fakeSalesAgent = {
    generate: jest.fn().mockResolvedValue({ text: FAKE_REPLY }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    MockRequestContextCtor.instances.length = 0;

    // buildMastra returns an object that looks enough like { mastra, salesAgent }
    // for AgentService to store and use.
    mockBuildMastra.mockReturnValue({
      mastra: {} as ReturnType<typeof buildMastra>['mastra'],
      salesAgent: fakeSalesAgent as unknown as ReturnType<
        typeof buildMastra
      >['salesAgent'],
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit
  // -------------------------------------------------------------------------

  it('onModuleInit calls buildMastra with an object containing connectionString', () => {
    const url = 'postgres://test-host/test-db';
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(url),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledTimes(1);
    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: url }),
    );
  });

  it('onModuleInit calls buildMastra with the agentBehavior service', () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({ agentBehavior: expect.anything() }),
    );
  });

  it('onModuleInit calls buildMastra with the knowledge service', () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({ knowledge: expect.anything() }),
    );
  });

  // -------------------------------------------------------------------------
  // handleMessage — scope derivation
  // -------------------------------------------------------------------------

  it('derives resourceId + threadId and passes the correct memory shape to generate', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'مرحبا',
      expect.objectContaining({
        memory: { resource: 'C1', thread: 'thread:C1' },
      }),
    );
  });

  it('calls findOrCreateByPsid with contactId and the derived threadId', async () => {
    const conversations = makeConversationsMock('convo-42');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا', adRef: undefined });

    expect(
      (conversations.findOrCreateByPsid as jest.Mock),
    ).toHaveBeenCalledWith('C1', { threadId: 'thread:C1', adRef: undefined });
  });

  // -------------------------------------------------------------------------
  // handleMessage — RequestContext identity
  // -------------------------------------------------------------------------

  it('requestContext carries contactId, conversationId, threadId and generate is called with it', async () => {
    const CONVO_ID = 'convo-ctx-test';
    const conversations = makeConversationsMock(CONVO_ID);
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا', adRef: 'spring' });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.get('contactId')).toBe('C1');
    expect(instance.sets.get('conversationId')).toBe(CONVO_ID);
    expect(instance.sets.get('threadId')).toBe('thread:C1');
    expect(instance.sets.get('adRef')).toBe('spring');

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestContext: expect.anything() }),
    );
  });

  it('does not set adRef on requestContext when adRef is not supplied', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.has('adRef')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // handleMessage — image-led routing injection (AIA-34 sub-task A)
  // -------------------------------------------------------------------------

  it('sets lastImageUrl and imageLed=true on requestContext when lastImageUrl is present', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const IMAGE_URL = 'https://cdn.example.com/customer-photo.jpg';
    await service.handleMessage({
      contactId: 'C1',
      text: 'شوفي هاي الصورة',
      lastImageUrl: IMAGE_URL,
    });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.get('lastImageUrl')).toBe(IMAGE_URL);
    expect(instance.sets.get('imageLed')).toBe(true);
  });

  it('does NOT set lastImageUrl or imageLed on requestContext when lastImageUrl is absent', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.has('lastImageUrl')).toBe(false);
    expect(instance.sets.has('imageLed')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // handleMessage — vision pre-step (AIA-28)
  // -------------------------------------------------------------------------

  it('runs the vision pre-step and seeds visionAttributes + a system note when an image is present', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    (visionMock.extractAttributes as jest.Mock).mockResolvedValueOnce({
      attributes: {
        isAbaya: true,
        confidence: 0.9,
        colorFamily: 'red',
        occasion: 'سهرة',
      },
      confidence: 0.9,
    });

    const IMAGE_URL = 'https://cdn.example.com/abaya.jpg';
    await service.handleMessage({
      contactId: 'C1',
      text: 'بدي هاي',
      lastImageUrl: IMAGE_URL,
    });

    expect(visionMock.extractAttributes).toHaveBeenCalledWith({ url: IMAGE_URL });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.get('visionAttributes')).toMatchObject({
      colorFamily: 'red',
    });

    // A system note steering the agent to search by the photographed design is
    // passed to generate as context.
    const options = fakeSalesAgent.generate.mock.calls[0][1];
    expect(options.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('السمات المستخرجة'),
        }),
      ]),
    );
  });

  it('does NOT run the vision pre-step when no image is present', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(visionMock.extractAttributes).not.toHaveBeenCalled();
  });

  it('proceeds normally (no visionAttributes) when the pre-step returns nothing', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    // visionMock default resolves { attributes: null }.
    await service.handleMessage({
      contactId: 'C1',
      text: 'شوفي',
      lastImageUrl: 'https://cdn.example.com/x.jpg',
    });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.has('visionAttributes')).toBe(false);
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // handleMessage — isolation (scope-derivation proxy)
  // -------------------------------------------------------------------------

  it('two calls with different contactIds produce different memory.resource scopes', async () => {
    // Note: true working-memory isolation (the Mastra PostgresStore separating
    // one customer's data from another's) is verified live with the real model+store.
    // This test is the unit-level proof that the service derives separate resourceIds.
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });
    await service.handleMessage({ contactId: 'C2', text: 'أهلاً' });

    const calls = fakeSalesAgent.generate.mock.calls;
    expect(calls[0][1]).toMatchObject({ memory: { resource: 'C1' } });
    expect(calls[1][1]).toMatchObject({ memory: { resource: 'C2' } });
  });

  // -------------------------------------------------------------------------
  // handleMessage — business record (addMessage)
  // -------------------------------------------------------------------------

  it('persists both the inbound customer message and the outbound agent reply', async () => {
    const CONVO_ID = 'convo-log';
    const conversations = makeConversationsMock(CONVO_ID);
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const addMessage = conversations.addMessage as jest.Mock;
    expect(addMessage).toHaveBeenCalledTimes(2);

    // First call — inbound (now carries the idempotency key)
    expect(addMessage).toHaveBeenNthCalledWith(1, {
      conversationId: CONVO_ID,
      role: 'customer',
      content: 'مرحبا',
      externalId: expect.any(String),
    });

    // Second call — outbound
    expect(addMessage).toHaveBeenNthCalledWith(2, {
      conversationId: CONVO_ID,
      role: 'agent',
      content: FAKE_REPLY,
    });
  });

  it('still returns the reply when a business-log write fails (best-effort)', async () => {
    // The customer reply is the primary product; a failure to persist the
    // secondary admin/eval log row must not throw or drop the reply.
    const conversations = makeConversationsMock();
    (conversations.addMessage as jest.Mock).mockRejectedValue(
      new Error('DB down'),
    );
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(result.reply).toBe(FAKE_REPLY);
  });

  // -------------------------------------------------------------------------
  // handleMessage — idempotency (AIA-30)
  // -------------------------------------------------------------------------

  it('short-circuits a duplicate inbound turn (no generate, empty reply)', async () => {
    const conversations = makeConversationsMock();
    (conversations.findMessageByExternalId as jest.Mock).mockResolvedValue({
      id: 'existing-msg',
    });
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      externalMessageId: 'mid-1',
    });

    expect(result.reply).toBe('');
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
    expect(conversations.addMessage).not.toHaveBeenCalled();
  });

  it('uses the provided externalMessageId as the idempotency key', async () => {
    const CONVO_ID = 'convo-idem';
    const conversations = makeConversationsMock(CONVO_ID);
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      externalMessageId: 'mid-xyz',
    });

    expect(conversations.findMessageByExternalId).toHaveBeenCalledWith(
      CONVO_ID,
      'mid-xyz',
    );
  });

  // -------------------------------------------------------------------------
  // handleMessage — reply
  // -------------------------------------------------------------------------

  it('returns { reply } equal to the generate text', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(result.reply).toBe(FAKE_REPLY);
  });

  // -------------------------------------------------------------------------
  // handleMessage — products extraction
  // -------------------------------------------------------------------------

  it('extracts and dedupes products from search_products toolResults (price as string)', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'إليك المنتجات',
      toolResults: [
        {
          payload: {
            toolName: 'search_products',
            isError: false,
            result: {
              products: [
                { id: 'p1', name: 'عباية', price: '45.000', available: true },
                // Duplicate — should be dropped
                { id: 'p1', name: 'dup', price: '45.000', available: true },
              ],
            },
          },
        },
      ],
    });

    const result = await service.handleMessage({ contactId: 'C1', text: 'عبايات' });

    // Deduped to one entry; price is the STRING '45.000' (not a number)
    expect(result.products).toEqual([{ id: 'p1', name: 'عباية', price: '45.000' }]);
    // No overflow — only 1 unique product, well under the 8-item cap
    expect(result.productOverflow).toBeUndefined();
  });

  it('sets productOverflow when matched products exceed the 8-item cap', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    // 11 distinct products → 8 rendered + 3 overflow
    const manyProducts = Array.from({ length: 11 }, (_, i) => ({
      id: `p${i}`,
      name: `عباية ${i}`,
      price: '45.000',
      available: true,
    }));

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'إليك المنتجات',
      toolResults: [
        {
          payload: {
            toolName: 'search_products',
            isError: false,
            result: { products: manyProducts },
          },
        },
      ],
    });

    const result = await service.handleMessage({ contactId: 'C1', text: 'عبايات' });

    expect(result.products).toHaveLength(8);
    expect(result.productOverflow).toBe(3);
  });

  // -------------------------------------------------------------------------
  // handleMessage — eval/match logging (AIA-33 data producer)
  // -------------------------------------------------------------------------

  it('writes eval metadata (tool, matched ids, image_led) on the outbound message', async () => {
    const CONVO_ID = 'convo-eval';
    const conversations = makeConversationsMock(CONVO_ID);
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'إليك المنتجات',
      toolResults: [
        {
          payload: {
            toolName: 'search_products',
            isError: false,
            result: {
              products: [
                { id: 'p1', name: 'عباية', price: '45.000' },
                { id: 'p2', name: 'عباية ٢', price: '50.000' },
              ],
            },
          },
        },
      ],
    });

    await service.handleMessage({ contactId: 'C1', text: 'عبايات' });

    const outbound = (conversations.addMessage as jest.Mock).mock.calls[1][0];
    expect(outbound).toMatchObject({
      role: 'agent',
      attributes: {
        eval: {
          tool: 'search_products',
          matched_product_ids: ['p1', 'p2'],
          image_led: false,
          confirmed: null,
        },
      },
    });
  });

  it('marks eval image_led=true and the tool when the match came from an image', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'شبيهات صورتك',
      toolResults: [
        {
          payload: {
            toolName: 'find_similar_by_image',
            isError: false,
            result: { products: [{ id: 'p9', name: 'عباية', price: '60.000' }] },
          },
        },
      ],
    });

    await service.handleMessage({
      contactId: 'C1',
      text: 'شوفي',
      lastImageUrl: 'https://cdn.example.com/x.jpg',
    });

    const outbound = (conversations.addMessage as jest.Mock).mock.calls[1][0];
    expect(outbound.attributes.eval).toMatchObject({
      tool: 'find_similar_by_image',
      matched_product_ids: ['p9'],
      image_led: true,
    });
  });

  it('omits eval attributes on the outbound message when no products were surfaced', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const outbound = (conversations.addMessage as jest.Mock).mock.calls[1][0];
    expect(outbound.attributes).toBeUndefined();
  });

  it('extracts products from find_similar_by_image toolResults (image-led reply card)', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'لقيتلك عبايات شبيهة بالصورة',
      toolResults: [
        {
          payload: {
            toolName: 'find_similar_by_image',
            isError: false,
            result: {
              products: [
                { id: 'v1', name: 'عباية مطابقة', price: '60.000', available: true },
              ],
            },
          },
        },
      ],
    });

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'شوفي هاي الصورة',
      lastImageUrl: 'https://cdn.example.com/p.jpg',
    });

    expect(result.products).toEqual([
      { id: 'v1', name: 'عباية مطابقة', price: '60.000' },
    ]);
    // Single product — no overflow
    expect(result.productOverflow).toBeUndefined();
  });

  it('returns products: undefined when toolResults is absent', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({ text: 'لا يوجد' });

    const result = await service.handleMessage({ contactId: 'C1', text: 'كيف الأسعار؟' });

    expect(result.products).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // handleMessage — bot-pause gate (ai_state !== 'bot')
  // -------------------------------------------------------------------------

  it('returns empty reply and skips generate when aiState is human', async () => {
    const CONVO_ID = 'convo-paused';
    const conversations = makeConversationsMock(CONVO_ID, 'human');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'وين طلبي؟' });

    // Silent — the handoff line was delivered once on the escalation turn itself.
    expect(result.reply).toBe('');
    // LLM must NOT be invoked
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
  });

  it('returns empty reply and skips generate when aiState is paused', async () => {
    const CONVO_ID = 'convo-paused-state';
    const conversations = makeConversationsMock(CONVO_ID, 'paused');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'هل الطلب جاهز؟' });

    expect(result.reply).toBe('');
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
  });

  it('logs inbound message exactly once when the pause gate fires', async () => {
    const CONVO_ID = 'convo-paused-log';
    const conversations = makeConversationsMock(CONVO_ID, 'human');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'وين طلبي؟' });

    const addMessage = conversations.addMessage as jest.Mock;
    // Only the inbound customer row — no outbound bot row
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      role: 'customer',
      content: 'وين طلبي؟',
      externalId: expect.any(String),
    });
  });

  it('pause gate includes imageUrl in the inbound log when lastImageUrl is present', async () => {
    const CONVO_ID = 'convo-paused-img';
    const conversations = makeConversationsMock(CONVO_ID, 'human');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const IMAGE_URL = 'https://cdn.example.com/photo.jpg';
    await service.handleMessage({ contactId: 'C1', text: 'صورة', lastImageUrl: IMAGE_URL });

    const addMessage = conversations.addMessage as jest.Mock;
    expect(addMessage).toHaveBeenCalledWith({
      conversationId: CONVO_ID,
      role: 'customer',
      content: 'صورة',
      externalId: expect.any(String),
      imageUrl: IMAGE_URL,
    });
  });

  it('does NOT pause when aiState is bot (normal conversation)', async () => {
    // aiState: 'bot' → normal generate() path.
    const conversations = makeConversationsMock('convo-bot', 'bot');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'عندك عبايات؟' });

    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(FAKE_REPLY);
  });

  it('does NOT pause for a fresh conversation (default aiState: bot)', async () => {
    // makeConversationsMock defaults to aiState:'bot'.
    const conversations = makeConversationsMock('convo-fresh');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      manychatControlMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(FAKE_REPLY);
  });
});
