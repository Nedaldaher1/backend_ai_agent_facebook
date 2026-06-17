/**
 * Unit tests for AgentService — Phase 1 (Mastra foundation).
 *
 * Strategy: mock the factory module so no real Anthropic API call or
 * Postgres connection is made.  The mock returns a salesAgent whose
 * `generate` is a jest.fn() that resolves immediately with a fixed text.
 *
 * Test coverage:
 *  1. `onModuleInit` calls `buildMastra` with the DATABASE_URL from config.
 *  2. `ping` delegates to `salesAgent.generate` with the correct memory shape
 *     and returns the `.text` string from the result.
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
// Jest (CJS) — same pattern as products.service.spec.ts. The stubs are never
// exercised: ProductsService is passed in as a bare mock.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));

import { AgentService } from '../agent.service';
import { buildMastra } from '../mastra/mastra.factory';
import type { ConfigService } from '@nestjs/config';
import type { ProductsService } from '@/modules/products/products.service';

// ---------------------------------------------------------------------------
// Typed cast helpers
// ---------------------------------------------------------------------------

const mockBuildMastra = buildMastra as jest.MockedFunction<typeof buildMastra>;

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

/** A fake ConfigService that returns the given DATABASE_URL. */
function makeConfigMock(url = 'postgres://x'): ConfigService {
  return { getOrThrow: () => url } as unknown as ConfigService;
}

/** A minimal ProductsService stub — none of its methods are exercised here. */
const productsMock = {} as unknown as ProductsService;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService', () => {
  // A stable fake reply used across tests.
  const FAKE_REPLY = 'مرحبا! كيف بقدر أساعدك؟';

  /** A minimal fake salesAgent with a mocked `generate`. */
  const fakeSalesAgent = {
    generate: jest.fn().mockResolvedValue({ text: FAKE_REPLY }),
  };

  beforeEach(() => {
    jest.clearAllMocks();

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

  it('onModuleInit calls buildMastra with the DATABASE_URL from config', () => {
    const url = 'postgres://test-host/test-db';
    const service = new AgentService(makeConfigMock(url), productsMock);

    service.onModuleInit();

    expect(mockBuildMastra).toHaveBeenCalledTimes(1);
    expect(mockBuildMastra).toHaveBeenCalledWith(url);
  });

  // -------------------------------------------------------------------------
  // ping
  // -------------------------------------------------------------------------

  it('ping returns a non-empty string after onModuleInit', async () => {
    const service = new AgentService(makeConfigMock(), productsMock);
    service.onModuleInit();

    const result = await service.ping('مرحبا', 'psid-x', 't1');

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('ping passes the correct memory shape to salesAgent.generate', async () => {
    const service = new AgentService(makeConfigMock(), productsMock);
    service.onModuleInit();

    await service.ping('ما أحلى العبايات؟', 'psid-abc', 'thread-42');

    expect(fakeSalesAgent.generate).toHaveBeenCalledWith(
      'ما أحلى العبايات؟',
      expect.objectContaining({
        memory: { resource: 'psid-abc', thread: 'thread-42' },
      }),
    );
  });

  it('ping resolves to the .text from the generate result', async () => {
    const service = new AgentService(makeConfigMock(), productsMock);
    service.onModuleInit();

    const reply = await service.ping('مرحبا', 'psid-x', 't1');

    expect(reply).toBe(FAKE_REPLY);
  });
});
