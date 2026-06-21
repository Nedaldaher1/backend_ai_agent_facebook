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
 */

// Mock the factory BEFORE any import of AgentService so the module-level
// `jest.mock` hoisting fires at the right time. Use an EXPLICIT factory (not
// automock) so Jest never loads the real mastra.factory.ts — automock would
// require the real module, pulling in @mastra/core whose ESM-only deps cannot
// be required under Jest (CJS).
jest.mock('../mastra/mastra.factory', () => ({ buildMastra: jest.fn() }));

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
 * A ConversationsService stub with findOrCreateByPsid and addMessage.
 * Both resolve immediately; addMessage call order is asserted in the tests.
 */
function makeConversationsMock(conversationId = 'convo-1'): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({ id: conversationId }),
    addMessage: jest.fn().mockResolvedValue({}),
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
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.has('lastImageUrl')).toBe(false);
    expect(instance.sets.has('imageLed')).toBe(false);
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
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    const addMessage = conversations.addMessage as jest.Mock;
    expect(addMessage).toHaveBeenCalledTimes(2);

    // First call — inbound
    expect(addMessage).toHaveBeenNthCalledWith(1, {
      conversationId: CONVO_ID,
      role: 'customer',
      content: 'مرحبا',
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
    );
    service.onModuleInit();

    const result = await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(result.reply).toBe(FAKE_REPLY);
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
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({ text: 'لا يوجد' });

    const result = await service.handleMessage({ contactId: 'C1', text: 'كيف الأسعار؟' });

    expect(result.products).toBeUndefined();
  });
});
