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

import { Logger } from '@nestjs/common';
import { AgentService } from '../agent.service';
import { FALLBACK_REPLY } from '../customer-reply.constants';
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
import type { TriageService } from '../triage/triage.service';

// ---------------------------------------------------------------------------
// Typed cast helpers
// ---------------------------------------------------------------------------

const mockBuildMastra = buildMastra as jest.MockedFunction<typeof buildMastra>;
const MockRequestContextCtor = RequestContext as unknown as jest.MockedClass<
  typeof RequestContext
> & {
  instances: Array<{
    sets: Map<string, unknown>;
    set: jest.Mock;
    get: jest.Mock;
  }>;
};

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

/** A fake ConfigService that returns the given DATABASE_URL, plus optional
 *  `get(key)` overrides (e.g. AGENT_MODEL_ID). Unknown keys → undefined, so the
 *  service falls back to its code defaults (e.g. MASTRA_LOG_LEVEL → 'info'). */
function makeConfigMock(
  url = 'postgres://x',
  overrides: Record<string, string | undefined> = {},
): ConfigService {
  return {
    getOrThrow: () => url,
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
}

/** A minimal ProductsService stub. Default: visual search finds nothing, so the
 * knowledge pre-fetch image branch is a no-op; image tests override per case. */
const productsMock = {
  findSimilarByImage: jest.fn().mockResolvedValue([]),
} as unknown as ProductsService;

/** A minimal OrdersService stub. */
const ordersMock = {} as unknown as OrdersService;

/** A minimal AgentBehaviorService stub. */
const agentBehaviorMock = {
  getInstructions: jest.fn().mockResolvedValue('x'),
} as unknown as AgentBehaviorService;

/** A minimal KnowledgeService stub. Default: no relevant entries, so the
 * knowledge pre-fetch injects nothing; pre-fetch tests override getRelevant. */
const knowledgeMock = {
  getRelevant: jest.fn().mockResolvedValue([]),
} as unknown as KnowledgeService;

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

/**
 * Triage tier disabled in unit tests (opt-in via TRIAGE_ENABLED); the
 * dedicated triage.service.spec covers its behavior. Turn tests below always
 * exercise the full agent path.
 */
const triageMock = {
  enabled: false,
  match: () => null,
} as unknown as TriageService;

/**
 * A ConversationsService stub with findOrCreateByPsid and addMessage.
 * Both resolve immediately; addMessage call order is asserted in the tests.
 *
 * @param conversationId  The id returned by findOrCreateByPsid (default 'convo-1').
 * @param aiState         The ai_state column value on the conversation row (default 'bot').
 *                        Pass 'human' or 'paused' to exercise the pause gate.
 * @param humanSummary    Optional human wrap-up summary (WS7). When set, the row
 *                        returned by findOrCreateByPsid carries it so the injection
 *                        path fires. Defaults to null (no summary).
 */
function makeConversationsMock(
  conversationId = 'convo-1',
  aiState: string = 'bot',
  humanSummary: string | null = null,
  pausedUntil: Date | null = null,
  state: unknown = undefined,
): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({
      id: conversationId,
      aiState,
      humanSummary,
      pausedUntil,
      // Free-form jsonb; the knowledge pre-fetch reads `lastProductIds`/`adProduct`.
      state,
    }),
    addMessage: jest.fn().mockResolvedValue({}),
    // Default: no prior message with this idempotency key (not a duplicate).
    findMessageByExternalId: jest.fn().mockResolvedValue(undefined),
    // WS7: one-shot clear of the human summary after injection.
    clearHumanSummary: jest.fn().mockResolvedValue(undefined),
    // Audit A1: timed-pause auto-resume writes ai_state + records a resume event.
    setAiState: jest
      .fn()
      .mockResolvedValue({ id: conversationId, aiState: 'bot' }),
    recordEvent: jest.fn().mockResolvedValue({}),
    // Knowledge pre-fetch (B): remembers the product(s) shown to the customer.
    mergeState: jest.fn().mockResolvedValue({}),
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

  /** A minimal fake Mastra Memory for the admin reset path. */
  const fakeMemory = {
    updateWorkingMemory: jest.fn().mockResolvedValue(undefined),
    deleteThread: jest.fn().mockResolvedValue(undefined),
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
      memory: fakeMemory as unknown as ReturnType<typeof buildMastra>['memory'],
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
      triageMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledTimes(1);
    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: url }),
    );
  });

  it('onModuleInit passes the default model id (Gemini 3.5 Flash via OpenRouter) to buildMastra', () => {
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      makeConversationsMock(),
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      triageMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'openrouter/google/gemini-3.5-flash',
      }),
    );
  });

  it('onModuleInit honours an AGENT_MODEL_ID override', () => {
    const service = new AgentService(
      makeConfigMock('postgres://x', {
        AGENT_MODEL_ID: 'openrouter/google/gemini-2.5-flash',
      }),
      productsMock,
      makeConversationsMock(),
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      triageMock,
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'openrouter/google/gemini-2.5-flash',
      }),
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
      triageMock,
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
      triageMock,
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
      triageMock,
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

  it('applies the default modelSettings (temp 0.5 / topP 0.8 / maxOutputTokens 768) to generate', async () => {
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      makeConversationsMock(),
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      triageMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'مرحبا',
      expect.objectContaining({
        modelSettings: { temperature: 0.5, topP: 0.8, maxOutputTokens: 768 },
      }),
    );
  });

  describe('AGENT_CONTEXT_PLACEMENT (prompt-prefix cache alignment)', () => {
    it("default 'tail' folds all per-turn notes into ONE user-role context message", async () => {
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        makeConversationsMock(),
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
        name: 'أم محمد',
      });

      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: Array<{ role: string; content: string }>;
      };
      expect(options.context).toHaveLength(1);
      expect(options.context?.[0].role).toBe('user');
      // Carries the note content + the not-from-the-customer disclaimer.
      expect(options.context?.[0].content).toContain('أم محمد');
      expect(options.context?.[0].content).toContain('ليست رسالة من الزبونة');
      // No system-role context message — the system prefix stays byte-stable.
      expect(
        options.context?.some((m) => m.role === 'system'),
      ).toBe(false);
    });

    it("'system' restores the legacy per-note system messages", async () => {
      const service = new AgentService(
        makeConfigMock('postgres://x', { AGENT_CONTEXT_PLACEMENT: 'system' }),
        productsMock,
        makeConversationsMock(),
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
        name: 'أم محمد',
      });

      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: Array<{ role: string; content: string }>;
      };
      expect(options.context).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('أم محمد'),
          }),
        ]),
      );
    });

    it('passes NO context at all when the turn has no dynamic notes', async () => {
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        makeConversationsMock(),
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: unknown;
      };
      expect(options.context).toBeUndefined();
    });
  });

  it('honours AGENT_TEMPERATURE / AGENT_TOP_P / AGENT_MAX_OUTPUT_TOKENS overrides (coerced to numbers)', async () => {
    const service = new AgentService(
      makeConfigMock('postgres://x', {
        AGENT_TEMPERATURE: '0.2',
        AGENT_TOP_P: '0.95',
        AGENT_MAX_OUTPUT_TOKENS: '256',
      }),
      productsMock,
      makeConversationsMock(),
      ordersMock,
      agentBehaviorMock,
      knowledgeMock,
      sizingMock,
      visionMock,
      triageMock,
    );
    service.onModuleInit();

    await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'مرحبا',
      expect.objectContaining({
        modelSettings: { temperature: 0.2, topP: 0.95, maxOutputTokens: 256 },
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
      triageMock,
    );
    service.onModuleInit();

    await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      adRef: undefined,
    });

    expect(conversations.findOrCreateByPsid as jest.Mock).toHaveBeenCalledWith(
      'C1',
      { threadId: 'thread:C1', adRef: undefined },
    );
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
      triageMock,
    );
    service.onModuleInit();

    await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      adRef: 'spring',
    });

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
      triageMock,
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
      triageMock,
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
      triageMock,
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
      triageMock,
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

    expect(visionMock.extractAttributes).toHaveBeenCalledWith({
      url: IMAGE_URL,
    });

    const instance = MockRequestContextCtor.instances[0];
    expect(instance.sets.get('visionAttributes')).toMatchObject({
      colorFamily: 'red',
    });

    // A note steering the agent to search by the photographed design is passed
    // to generate as context (placement-agnostic; the AGENT_CONTEXT_PLACEMENT
    // tests pin down where it rides).
    const options = fakeSalesAgent.generate.mock.calls[0][1];
    expect(options.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
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
      triageMock,
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
      triageMock,
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
      triageMock,
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
      triageMock,
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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
    });

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
      triageMock,
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
      triageMock,
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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
    });

    expect(result.reply).toBe(FAKE_REPLY);
  });

  // -------------------------------------------------------------------------
  // handleMessage — empty-generation guard + reply sanitisation
  // -------------------------------------------------------------------------

  describe('empty-generation guard + sanitisation', () => {
    const make = (conversations: ConversationsService) => {
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();
      return service;
    };

    it('retries once and falls back to a clean line when generate returns empty text twice', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      fakeSalesAgent.generate
        .mockResolvedValueOnce({ text: '   ', finishReason: 'length' })
        .mockResolvedValueOnce({ text: '', finishReason: 'length' });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(2);
      expect(result.reply).toBe(FALLBACK_REPLY);
      // The outbound business-log row carries the fallback, never an empty string.
      const outbound = (conversations.addMessage as jest.Mock).mock.calls[1][0];
      expect(outbound.content).toBe(FALLBACK_REPLY);
    });

    it('retries once and uses the retry text when the second generate succeeds', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      fakeSalesAgent.generate
        .mockResolvedValueOnce({ text: '' })
        .mockResolvedValueOnce({ text: 'رجعت بنص هالمرة' });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(2);
      expect(result.reply).toBe('رجعت بنص هالمرة');
    });

    it('does NOT retry when the first generation already has text', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      fakeSalesAgent.generate.mockResolvedValueOnce({ text: 'رد مباشر' });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
      expect(result.reply).toBe('رد مباشر');
    });

    it('does NOT retry on a clean empty stop — goes straight to fallback (token-saving)', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      // finishReason 'stop' with empty text = the model deliberately said nothing;
      // a retry would just burn another full generation, so use the fallback.
      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: '',
        finishReason: 'stop',
      });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
      expect(result.reply).toBe(FALLBACK_REPLY);
    });

    it('forwards the configured maxSteps to generate()', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      fakeSalesAgent.generate.mockResolvedValueOnce({ text: 'تمام' });

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      const opts = fakeSalesAgent.generate.mock.calls[0][1];
      expect(opts.maxSteps).toBe(6);
    });

    it('does NOT retry when truncated at the step cap (finishReason tool-calls)', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      // Hitting maxSteps while still wanting tools → empty text + 'tool-calls'; a
      // re-run hits the same wall, so go straight to the fallback (no 2x cost).
      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: '',
        finishReason: 'tool-calls',
      });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
      expect(result.reply).toBe(FALLBACK_REPLY);
    });

    it('strips emoji from the reply deterministically', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);

      // \u{1F60D} = 😍. The reply must come back emoji-free and double-space-tidied.
      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: 'تمام \u{1F60D} حياتي',
      });

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(result.reply).toBe('تمام حياتي');
    });

    it('logs the capture_order outcome (new order id) in the per-turn tool line', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: 'تم تسجيل طلبك',
        toolResults: [
          {
            payload: {
              toolName: 'capture_order',
              isError: false,
              result: { ok: true, order_id: 'ord-9' },
            },
          },
        ],
      });

      await service.handleMessage({ contactId: 'C1', text: 'بدي اطلب' });

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) =>
            l.includes('capture_order') && l.includes('order ord-9 created'),
        ),
      ).toBe(true);
      logSpy.mockRestore();
    });

    it('logs the capture_order refusal reason (ok:false is not isError)', async () => {
      const conversations = makeConversationsMock();
      const service = make(conversations);
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);

      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: 'اللون مش متوفر',
        toolResults: [
          {
            payload: {
              toolName: 'capture_order',
              isError: false,
              result: { ok: false, reason: 'اللون غير متوفر' },
            },
          },
        ],
      });

      await service.handleMessage({ contactId: 'C1', text: 'بدي اطلب' });

      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) =>
            l.includes('capture_order') &&
            l.includes('NOT created') &&
            l.includes('اللون غير متوفر'),
        ),
      ).toBe(true);
      logSpy.mockRestore();
    });
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
      triageMock,
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

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'عبايات',
    });

    // Deduped to one entry; price is the STRING '45.000' (not a number)
    expect(result.products).toEqual([
      { id: 'p1', name: 'عباية', price: '45.000' },
    ]);
    // No overflow — only 1 unique product, well under the 8-item cap
    expect(result.productOverflow).toBeUndefined();
  });

  it('drains the per-turn mediaSink into reply.images (deduped, http(s) only)', async () => {
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
      triageMock,
    );
    service.onModuleInit();

    // The get_product_media tool pushes the SERVICE-selected URLs into the
    // mediaSink AgentService placed on the request context — simulate that here.
    fakeSalesAgent.generate.mockImplementationOnce(
      (
        _text: string,
        opts: { requestContext: { get: (k: string) => unknown } },
      ) => {
        const sink = opts.requestContext.get('mediaSink') as string[];
        sink.push(
          'https://pub.r2.dev/a.jpeg',
          'https://pub.r2.dev/b.jpeg',
          'https://pub.r2.dev/a.jpeg', // duplicate — dropped
          'ftp://pub.r2.dev/clip', // non-http(s) — dropped
        );
        return Promise.resolve({ text: 'تفضلي صور العباية', toolResults: [] });
      },
    );

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'ورجيني الصور',
    });

    expect(result.images).toEqual([
      'https://pub.r2.dev/a.jpeg',
      'https://pub.r2.dev/b.jpeg',
    ]);
  });

  it('omits reply.images when no get_product_media tool ran', async () => {
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
      triageMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'أهلاً',
      toolResults: [],
    });

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
    });

    expect(result.images).toBeUndefined();
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
      triageMock,
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

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'عبايات',
    });

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
      triageMock,
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
      triageMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({
      text: 'شبيهات صورتك',
      toolResults: [
        {
          payload: {
            toolName: 'find_similar_by_image',
            isError: false,
            result: {
              products: [{ id: 'p9', name: 'عباية', price: '60.000' }],
            },
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
      triageMock,
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
      triageMock,
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
                {
                  id: 'v1',
                  name: 'عباية مطابقة',
                  price: '60.000',
                  available: true,
                },
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
      triageMock,
    );
    service.onModuleInit();

    fakeSalesAgent.generate.mockResolvedValueOnce({ text: 'لا يوجد' });

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'كيف الأسعار؟',
    });

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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'وين طلبي؟',
    });

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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'هل الطلب جاهز؟',
    });

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
      triageMock,
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
      triageMock,
    );
    service.onModuleInit();

    const IMAGE_URL = 'https://cdn.example.com/photo.jpg';
    await service.handleMessage({
      contactId: 'C1',
      text: 'صورة',
      lastImageUrl: IMAGE_URL,
    });

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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'عندك عبايات؟',
    });

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
      triageMock,
    );
    service.onModuleInit();

    const result = await service.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
    });

    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe(FAKE_REPLY);
  });

  // -------------------------------------------------------------------------
  // handleMessage — timed-pause auto-resume (audit A1)
  // -------------------------------------------------------------------------

  describe('timed-pause auto-resume (audit A1)', () => {
    const makeService = (conversations: ConversationsService) => {
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();
      return service;
    };

    it('auto-resumes a paused conversation whose window has elapsed, then generates', async () => {
      const past = new Date(Date.now() - 60_000);
      const conversations = makeConversationsMock(
        'convo-exp',
        'paused',
        null,
        past,
      );
      const service = makeService(conversations);

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(conversations.setAiState).toHaveBeenCalledWith('convo-exp', {
        aiState: 'bot',
        pausedUntil: null,
      });
      expect(conversations.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'resume',
          toState: 'bot',
          actorType: 'system',
        }),
      );
      expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
      expect(result.reply).toBe(FAKE_REPLY);
    });

    it('stays silent (no resume, no generate) when the pause window is still in the future', async () => {
      const future = new Date(Date.now() + 60_000);
      const conversations = makeConversationsMock(
        'convo-fut',
        'paused',
        null,
        future,
      );
      const service = makeService(conversations);

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(result.reply).toBe('');
      expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
      expect(conversations.setAiState).not.toHaveBeenCalled();
    });

    it('stays silent for an indefinite pause (pausedUntil null)', async () => {
      const conversations = makeConversationsMock(
        'convo-ind',
        'paused',
        null,
        null,
      );
      const service = makeService(conversations);

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(result.reply).toBe('');
      expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
      expect(conversations.setAiState).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleMessage — human summary injection (WS7 / AIA-34)
  // -------------------------------------------------------------------------

  describe('human summary injection (WS7)', () => {
    it('injects the summary as a system message and clears it when humanSummary is set', async () => {
      const CONVO_ID = 'convo-ws7-summary';
      const SUMMARY = 'الزبونة تريد تأكيد لون العباية قبل الإرسال';
      // aiState:'bot' (resumed), humanSummary carries the wrap-up text.
      const conversations = makeConversationsMock(CONVO_ID, 'bot', SUMMARY);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      // generate() must have been called with a context array that contains a
      // message whose content includes the summary text (placement-agnostic;
      // the AGENT_CONTEXT_PLACEMENT tests pin down where it rides).
      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: Array<{ role: string; content: string }>;
      };
      expect(options.context).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining(SUMMARY),
          }),
        ]),
      );

      // clearHumanSummary must be called exactly once with the conversation id.
      expect(conversations.clearHumanSummary).toHaveBeenCalledTimes(1);
      expect(conversations.clearHumanSummary).toHaveBeenCalledWith(CONVO_ID);
    });

    it('does NOT inject a summary system message or call clearHumanSummary when humanSummary is null', async () => {
      // Default makeConversationsMock: humanSummary = null.
      const CONVO_ID = 'convo-ws7-no-summary';
      const conversations = makeConversationsMock(CONVO_ID, 'bot', null);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      // context must either be undefined or not contain a summary message.
      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: Array<{ role: string; content: string }>;
      };
      const summaryMsg = (options.context ?? []).find((m) =>
        m.content.includes('ملخص ما تم مع فريق الدعم'),
      );
      expect(summaryMsg).toBeUndefined();

      // clearHumanSummary must NOT be called when there is no summary.
      expect(conversations.clearHumanSummary).not.toHaveBeenCalled();
    });

    it('does NOT clear the summary when generate() throws — kept for the retry (audit A2)', async () => {
      const SUMMARY = 'سياق التحويل يجب أن يبقى';
      const conversations = makeConversationsMock(
        'convo-ws7-fail',
        'bot',
        SUMMARY,
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
        triageMock,
      );
      service.onModuleInit();

      // The turn fails after the summary was injected into context.
      fakeSalesAgent.generate.mockRejectedValueOnce(new Error('Claude 429'));

      await expect(
        service.handleMessage({ contactId: 'C1', text: 'مرحبا' }),
      ).rejects.toThrow('Claude 429');

      // The one-shot summary must survive a failed turn so the next attempt
      // still injects it (before the fix it was cleared before generate()).
      expect(conversations.clearHumanSummary).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // handleMessage — deterministic knowledge pre-fetch (RAG)
  // -------------------------------------------------------------------------

  describe('knowledge pre-fetch (RAG)', () => {
    const KNOWLEDGE_NOTE_MARKER = 'معرفة جاهزة من قاعدة بيانات المتجر';

    /** A KnowledgeService whose getRelevant returns the given entries. */
    function makeKnowledgeMock(entries: unknown[]): KnowledgeService {
      return {
        getRelevant: jest.fn().mockResolvedValue(entries),
      } as unknown as KnowledgeService;
    }

    /** The injected knowledge system message from the first generate() call. */
    function findKnowledgeNote():
      | { role: string; content: string }
      | undefined {
      const options = fakeSalesAgent.generate.mock.calls[0][1] as {
        context?: Array<{ role: string; content: string }>;
      };
      return (options.context ?? []).find((m) =>
        m.content.includes(KNOWLEDGE_NOTE_MARKER),
      );
    }

    it('resolves the product from state.lastProductIds and injects its FAQ before generate', async () => {
      const conversations = makeConversationsMock('c-kp1', 'bot', null, null, {
        lastProductIds: ['prod-1'],
      });
      const knowledge = makeKnowledgeMock([
        {
          id: 'k1',
          title: 'كم السعر',
          content: '12 دينار',
          category: 'canned_response',
          productId: 'prod-1',
        },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      // Text carries an FAQ keyword (قماش) so the default 'gated' mode runs
      // the pre-fetch; keyword-free turns are covered by the gating tests below.
      await service.handleMessage({ contactId: 'C1', text: 'شو خامة قماشها؟' });

      // Product tier queried with the resolved id; no global fallback needed.
      expect(knowledge.getRelevant).toHaveBeenCalledWith({
        productIds: ['prod-1'],
      });
      const note = findKnowledgeNote();
      expect(note).toBeDefined();
      expect(note?.content).toContain('12 دينار');
    });

    it('resolves the product from the photo this turn via findSimilarByImage', async () => {
      const conversations = makeConversationsMock('c-kp2');
      const products = {
        findSimilarByImage: jest
          .fn()
          .mockResolvedValue([{ id: 'prod-img', similarity: 0.9 }]),
      } as unknown as ProductsService;
      const knowledge = makeKnowledgeMock([
        { id: 'k2', title: 'المقاسات', content: 'أرسلي وزنك وطولك' },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        products,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({
        contactId: 'C1',
        text: 'كم مقاسي؟',
        lastImageUrl: 'https://cdn.example.com/a.jpg',
      });

      expect(products.findSimilarByImage).toHaveBeenCalledWith(
        'https://cdn.example.com/a.jpg',
      );
      expect(knowledge.getRelevant).toHaveBeenCalledWith({
        productIds: ['prod-img'],
      });
      expect(findKnowledgeNote()).toBeDefined();
    });

    it('falls back to a global query lookup when no product is in context', async () => {
      const conversations = makeConversationsMock('c-kp3'); // state undefined
      const knowledge = makeKnowledgeMock([
        { id: 'g1', title: 'الشحن', content: 'التوصيل ٢ دينار' },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'كم التوصيل؟' });

      expect(knowledge.getRelevant).toHaveBeenCalledWith({
        query: 'كم التوصيل؟',
      });
      expect(findKnowledgeNote()).toBeDefined();
    });

    it('caps the injected note to the entry limit and truncates long content', async () => {
      const conversations = makeConversationsMock(
        'c-kp-cap',
        'bot',
        null,
        null,
        {
          lastProductIds: ['prod-1'],
        },
      );
      const longContent = 'ت'.repeat(800);
      const knowledge = makeKnowledgeMock([
        { id: 'k1', title: 'سؤال١', content: longContent },
        { id: 'k2', title: 'سؤال٢', content: 'جواب٢' },
        { id: 'k3', title: 'سؤال٣', content: 'جواب٣' },
        { id: 'k4', title: 'سؤال٤', content: 'جواب٤' },
        { id: 'k5', title: 'سؤال٥', content: 'جواب٥' },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({
        contactId: 'C1',
        text: 'شو سياسة الاستبدال عندكم؟',
      });

      const note = findKnowledgeNote();
      expect(note).toBeDefined();
      // Default cap is 3 entries — the 4th/5th must not appear.
      expect(note?.content).toContain('سؤال١');
      expect(note?.content).toContain('سؤال٣');
      expect(note?.content).not.toContain('سؤال٤');
      // Long content truncated (default 500 chars) with an ellipsis.
      expect(note?.content).toContain('…');
      expect(note?.content).not.toContain(longContent);
    });

    it('gated mode (default) skips the pre-fetch entirely on a non-FAQ turn — no query, no note', async () => {
      const conversations = makeConversationsMock(
        'c-kp-gate',
        'bot',
        null,
        null,
        {
          lastProductIds: ['prod-1'],
        },
      );
      const knowledge = makeKnowledgeMock([
        { id: 'k1', title: 'كم السعر', content: '12 دينار' },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      // A search/order move with no FAQ keyword — the ~300-750-token note
      // must not be paid for on turns like this.
      await service.handleMessage({ contactId: 'C1', text: 'بدي أطلب هاي' });

      expect(knowledge.getRelevant).not.toHaveBeenCalled();
      expect(findKnowledgeNote()).toBeUndefined();
    });

    it('KNOWLEDGE_PREFETCH_MODE=always restores the legacy inject-every-turn behavior', async () => {
      const conversations = makeConversationsMock(
        'c-kp-always',
        'bot',
        null,
        null,
        {
          lastProductIds: ['prod-1'],
        },
      );
      const knowledge = makeKnowledgeMock([
        { id: 'k1', title: 'كم السعر', content: '12 دينار' },
      ]);
      const service = new AgentService(
        makeConfigMock('postgres://x', { KNOWLEDGE_PREFETCH_MODE: 'always' }),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'بدي أطلب هاي' });

      expect(knowledge.getRelevant).toHaveBeenCalledWith({
        productIds: ['prod-1'],
      });
      expect(findKnowledgeNote()).toBeDefined();
    });

    it('KNOWLEDGE_PREFETCH_MODE=off never injects, even on FAQ-looking turns', async () => {
      const conversations = makeConversationsMock(
        'c-kp-off',
        'bot',
        null,
        null,
        {
          lastProductIds: ['prod-1'],
        },
      );
      const knowledge = makeKnowledgeMock([
        { id: 'k1', title: 'الشحن', content: 'التوصيل ٢ دينار' },
      ]);
      const service = new AgentService(
        makeConfigMock('postgres://x', { KNOWLEDGE_PREFETCH_MODE: 'off' }),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'قديش التوصيل؟' });

      expect(knowledge.getRelevant).not.toHaveBeenCalled();
      expect(findKnowledgeNote()).toBeUndefined();
    });

    it('skips the global fallback for a phone-only (non-question) input', async () => {
      const conversations = makeConversationsMock('c-kp-phone'); // no product context
      const knowledge = makeKnowledgeMock([
        { id: 'g1', title: 'الشحن', content: 'التوصيل ٢ دينار' },
      ]);
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: '0791234567' });

      // No product context + a phone-only input → no query, no injected note.
      expect(knowledge.getRelevant).not.toHaveBeenCalled();
      expect(findKnowledgeNote()).toBeUndefined();
    });

    it('injects nothing when no knowledge is found (agent proceeds per guardrails)', async () => {
      const conversations = makeConversationsMock('c-kp4');
      const knowledge = makeKnowledgeMock([]); // empty in both tiers
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      expect(findKnowledgeNote()).toBeUndefined();
    });

    it('never breaks the reply when the pre-fetch throws (best-effort)', async () => {
      const conversations = makeConversationsMock('c-kp5');
      const knowledge = {
        getRelevant: jest.fn().mockRejectedValue(new Error('DB down')),
      } as unknown as KnowledgeService;
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledge,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      const result = await service.handleMessage({
        contactId: 'C1',
        text: 'مرحبا',
      });

      expect(result.reply).toBe(FAKE_REPLY);
      expect(findKnowledgeNote()).toBeUndefined();
    });

    it('persists lastProductIds (media first, then matched) after a turn that showed products', async () => {
      const conversations = makeConversationsMock('c-kp6');
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      fakeSalesAgent.generate.mockResolvedValueOnce({
        text: 'تفضلي',
        toolResults: [
          {
            payload: {
              toolName: 'search_products',
              isError: false,
              result: { products: [{ id: 's1' }, { id: 's2' }] },
            },
          },
          {
            payload: {
              toolName: 'get_product_media',
              isError: false,
              args: { product_id: 'pm1' },
            },
          },
        ],
      });

      await service.handleMessage({ contactId: 'C1', text: 'ورجيني' });

      // get_product_media product (the photos she's viewing) ranks first.
      expect(conversations.mergeState).toHaveBeenCalledWith('c-kp6', {
        lastProductIds: ['pm1', 's1', 's2'],
      });
    });

    it('does NOT persist lastProductIds when no products were shown', async () => {
      const conversations = makeConversationsMock('c-kp7');
      const service = new AgentService(
        makeConfigMock(),
        productsMock,
        conversations,
        ordersMock,
        agentBehaviorMock,
        knowledgeMock,
        sizingMock,
        visionMock,
        triageMock,
      );
      service.onModuleInit();

      await service.handleMessage({ contactId: 'C1', text: 'مرحبا' });

      expect(conversations.mergeState).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // resetConversationMemory (admin "reset conversation")
  // -------------------------------------------------------------------------

  describe('resetConversationMemory', () => {
    it('clears resource working memory and deletes the thread for the psid', async () => {
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
        triageMock,
      );
      service.onModuleInit();

      await service.resetConversationMemory('C1');

      expect(fakeMemory.updateWorkingMemory).toHaveBeenCalledWith({
        threadId: 'thread:C1',
        resourceId: 'C1',
        workingMemory: '',
      });
      expect(fakeMemory.deleteThread).toHaveBeenCalledWith('thread:C1');
    });

    it('throws when deleting the thread fails (so the admin sees the failure)', async () => {
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
        triageMock,
      );
      service.onModuleInit();
      fakeMemory.deleteThread.mockRejectedValueOnce(new Error('thread gone'));

      // A silently-swallowed failure here previously let the agent keep
      // remembering the customer after a "reset"; the wipe must surface failures.
      await expect(service.resetConversationMemory('C1')).rejects.toThrow(
        /memory wipe failed/i,
      );
      // Working memory was still cleared before the failing step.
      expect(fakeMemory.updateWorkingMemory).toHaveBeenCalled();
    });

    it('throws when clearing working memory fails but STILL attempts the thread delete', async () => {
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
        triageMock,
      );
      service.onModuleInit();
      fakeMemory.updateWorkingMemory.mockRejectedValueOnce(
        new Error('storage unavailable'),
      );

      await expect(service.resetConversationMemory('C1')).rejects.toThrow(
        /memory wipe failed/i,
      );
      // Both steps are attempted so neither failure masks the other.
      expect(fakeMemory.deleteThread).toHaveBeenCalledWith('thread:C1');
    });
  });

  // Escalation DB state is owned by the escalate_to_human tool via
  // ConversationsService. The tool-level tests in the tools spec cover that path.
});
