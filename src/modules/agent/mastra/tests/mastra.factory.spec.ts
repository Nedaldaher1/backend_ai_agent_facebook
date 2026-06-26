/**
 * mastra.factory.spec.ts — Regression guard for the conversation-reset bug.
 *
 * The customer's name/size/colours live in Mastra RESOURCE-scoped working memory
 * (mastra_resources). The admin "reset conversation" action clears it by calling
 * `memory.updateWorkingMemory` / `memory.deleteThread` DIRECTLY (outside any
 * agent.generate()). Mastra only wires storage into an agent's memory LAZILY —
 * on the first generate() — so if the factory builds Memory WITHOUT its own
 * storage, the standalone reset throws "Memory requires a storage provider",
 * the failure is logged, and the agent keeps remembering the customer after a
 * "reset".
 *
 * The fix gives Memory its OWN storage at construction (`new Memory({ storage })`),
 * which sets `hasOwnStorage = true` so the reset works independent of generate().
 * This test asserts that wiring: the factory passes the SAME PostgresStore to
 * Memory and to Mastra, and keeps working memory resource-scoped.
 *
 * Mastra's pieces are mocked so construction is side-effect-free (no DB connect):
 * the assertion is on how the factory WIRES them, not on Mastra's internals.
 */

// A stub PostgresStore instance shared by the mock so we can assert identity.
const stubStore = { id: 'masa-mastra-store', __stub: 'PostgresStore' };

jest.mock('@mastra/pg', () => ({
  PostgresStore: jest.fn().mockImplementation(() => stubStore),
}));
jest.mock('@mastra/memory', () => ({ Memory: jest.fn() }));
jest.mock('@mastra/core', () => ({ Mastra: jest.fn() }));
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));
jest.mock('@mastra/loggers', () => ({ PinoLogger: jest.fn() }));
// The factory imports `../tools/index`; from this test file that module resolves
// via `../../tools/index`. Stub it so we don't pull real tool dependencies.
jest.mock('../../tools/index', () => ({ buildSalesTools: jest.fn(() => ({})) }));

import { Memory } from '@mastra/memory';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { buildMastra, type BuildMastraDeps } from '../mastra.factory';

const MemoryMock = Memory as unknown as jest.Mock;
const MastraMock = Mastra as unknown as jest.Mock;
const AgentMock = Agent as unknown as jest.Mock;

/** Minimal stub deps — none are exercised at construction time. */
function makeDeps(): BuildMastraDeps {
  const svc = {} as unknown;
  return {
    connectionString: 'postgresql://test:test@localhost:5432/test',
    products: svc as BuildMastraDeps['products'],
    orders: svc as BuildMastraDeps['orders'],
    conversations: svc as BuildMastraDeps['conversations'],
    knowledge: svc as BuildMastraDeps['knowledge'],
    sizing: svc as BuildMastraDeps['sizing'],
    agentBehavior: svc as BuildMastraDeps['agentBehavior'],
    logLevel: 'silent',
    lastMessages: 10,
  };
}

describe('buildMastra — Memory storage wiring', () => {
  afterEach(() => jest.clearAllMocks());

  it('constructs Memory WITH its own storage (so reset works before any generate)', () => {
    buildMastra(makeDeps());

    // The crux: passing `storage` to the Memory constructor sets hasOwnStorage,
    // which is what lets the standalone reset path (updateWorkingMemory /
    // deleteThread) resolve storage without a prior generate(). Omitting it is
    // the bug.
    expect(MemoryMock).toHaveBeenCalledTimes(1);
    const memoryArg = MemoryMock.mock.calls[0][0];
    expect(memoryArg.storage).toBe(stubStore);
  });

  it('passes the SAME PostgresStore instance to both Memory and Mastra', () => {
    buildMastra(makeDeps());

    // Same instance + same `mastra` schema → the generate() path (via Mastra)
    // and the reset path (via Memory's own storage) read/write the same rows.
    const mastraArg = MastraMock.mock.calls[0][0];
    expect(mastraArg.storage).toBe(stubStore);
    expect(MemoryMock.mock.calls[0][0].storage).toBe(stubStore);
  });

  it('keeps working memory resource-scoped (name/size persist per customer)', () => {
    buildMastra(makeDeps());

    const memoryArg = MemoryMock.mock.calls[0][0];
    expect(memoryArg.options.workingMemory).toMatchObject({
      enabled: true,
      scope: 'resource',
    });
  });

  it('forwards the configured lastMessages into Memory options', () => {
    buildMastra({ ...makeDeps(), lastMessages: 7 });

    const memoryArg = MemoryMock.mock.calls[0][0];
    expect(memoryArg.options.lastMessages).toBe(7);
  });

  it('registers the agent with the built memory instance', () => {
    const { memory } = buildMastra(makeDeps());

    const agentArg = AgentMock.mock.calls[0][0];
    expect(agentArg.memory).toBe(memory);
  });
});
