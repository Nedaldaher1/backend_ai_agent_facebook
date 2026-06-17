/**
 * Unit tests for AgentService — Phase 2 (tools wired in).
 *
 * Strategy: mock the factory module so no real Anthropic API call or
 * Postgres connection is made. The mock returns a salesAgent whose
 * `generate` is a jest.fn() that resolves immediately with a fixed text.
 *
 * Test coverage:
 *  1. `onModuleInit` calls `buildMastra` with an object containing
 *     `connectionString` (the DATABASE_URL from config) plus the three
 *     injected services.
 *  2. `ping` finds-or-creates a Conversation via ConversationsService, then
 *     delegates to `salesAgent.generate` with the correct memory shape AND
 *     a requestContext.
 *  3. `ping` resolves to the `.text` string from the generate result.
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

// RequestContext is used by AgentService.ping. We mock @mastra/core/di so Jest
// doesn't load the real ESM module. The mock provides a minimal implementation
// that lets us assert requestContext.set() was called with the right values.
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

/** A ConversationsService stub whose findOrCreateByPsid always resolves. */
function makeConversationsMock(conversationId = 'convo-1'): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({ id: conversationId }),
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
    );

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledWith(
      expect.objectContaining({ agentBehavior: expect.anything() }),
    );
  });

  // -------------------------------------------------------------------------
  // ping
  // -------------------------------------------------------------------------

  it('ping returns a non-empty string after onModuleInit', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
    );
    service.onModuleInit();

    const result = await service.ping('مرحبا', 'psid-x', 't1');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('ping passes the correct memory shape to salesAgent.generate', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
    );
    service.onModuleInit();

    await service.ping('ما أحلى العبايات؟', 'psid-abc', 'thread-42');

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'ما أحلى العبايات؟',
      expect.objectContaining({
        memory: { resource: 'psid-abc', thread: 'thread-42' },
      }),
    );
  });

  it('ping includes a requestContext in the generate call', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
    );
    service.onModuleInit();

    await service.ping('مرحبا', 'psid-x', 't1');

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'مرحبا',
      expect.objectContaining({ requestContext: expect.anything() }),
    );
  });

  it('ping calls findOrCreateByPsid before generating', async () => {
    const conversations = makeConversationsMock('convo-42');
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
    );
    service.onModuleInit();

    await service.ping('مرحبا', 'psid-x', 't1');

    expect(
      (conversations.findOrCreateByPsid as jest.Mock),
    ).toHaveBeenCalledWith('psid-x', { threadId: 't1' });
  });

  it('ping resolves to the .text from the generate result', async () => {
    const conversations = makeConversationsMock();
    const service = new AgentService(
      makeConfigMock(),
      productsMock,
      conversations,
      ordersMock,
      agentBehaviorMock,
    );
    service.onModuleInit();

    const reply = await service.ping('مرحبا', 'psid-x', 't1');

    expect(reply).toBe(FAKE_REPLY);
  });
});
