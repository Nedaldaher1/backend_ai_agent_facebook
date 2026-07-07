/**
 * Focused unit tests for the AgentService voice-note pre-step + deterministic
 * degrade flow (WS: voice understanding).
 *
 * Covers, via mocked TranscriptionService (no real download / model call):
 *  - happy path: transcript becomes the generate() input; the business-log row
 *    carries the Arabic marker + attributes.audio metadata; counter resets.
 *  - voice-only unusable turn #1: in-persona retry ask, voiceFailCount=1,
 *    generate() never called.
 *  - voice-only unusable turn #2: escalateToHuman('voice_not_understood…'),
 *    HANDOFF_REPLY returned, counter reset.
 *  - too_long/too_large → the dedicated "too long" reply.
 *  - failed voice + typed text: full agent runs on the typed text (no strike).
 *  - aiState != 'bot': still transcribed + logged for the human, stays silent.
 *  - triage never swallows a voice turn.
 *
 * Strategy: same mocks as agent.service.spec.ts / agent.service.dedup.spec.ts.
 * No real DB, no real model.
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

import { stubTenantDb } from './tenant-db.stub';
import { AgentService } from '../agent.service';
import { buildMastra } from '../mastra/mastra.factory';
import { HANDOFF_REPLY } from '../handoff.constants';
import {
  VOICE_FAILED_MARKER,
  VOICE_NOTE_MARKER,
  VOICE_RETRY_REPLY,
  VOICE_TOO_LONG_REPLY,
} from '../voice.constants';
import type { TranscriptionResult } from '../transcription/transcription.service';
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
// Shared fakes
// ---------------------------------------------------------------------------

const fakeSalesAgent = { generate: jest.fn() };

function makeConfigMock(): ConfigService {
  return {
    getOrThrow: () => 'postgres://x',
    get: () => undefined,
  } as unknown as ConfigService;
}

const productsMock = {} as unknown as ProductsService;
const ordersMock = {} as unknown as OrdersService;
const agentBehaviorMock = {
  getInstructions: jest.fn().mockResolvedValue('x'),
} as unknown as AgentBehaviorService;
const knowledgeMock = {} as unknown as KnowledgeService;
const sizingMock = { recommendSize: jest.fn() } as unknown as SizingService;
const visionMock = {
  extractAttributes: jest
    .fn()
    .mockResolvedValue({ attributes: null, confidence: null }),
} as unknown as VisionService;
const triageMock = {
  enabled: false,
  match: () => null,
} as unknown as TriageService;

const AUDIO_URL = 'https://cdn.fb.com/voice.mp4';

function usableVoice(
  over: Partial<TranscriptionResult> = {},
): TranscriptionResult {
  return {
    ok: true,
    transcript: 'بدي عباية سوداء مقاس 54',
    language: 'ar-JO',
    confidence: 0.9,
    meta: { model: 'openrouter/test', latencyMs: 5 },
    ...over,
  };
}

function unusableVoice(
  reason: NonNullable<TranscriptionResult['reason']>,
): TranscriptionResult {
  return {
    ok: false,
    transcript: null,
    confidence: null,
    reason,
    meta: { model: 'openrouter/test', latencyMs: 5 },
  };
}

function makeTranscription(result: TranscriptionResult): TranscriptionService {
  return {
    transcribe: jest.fn().mockResolvedValue(result),
  } as unknown as TranscriptionService;
}

function makeConversations(over: {
  state?: Record<string, unknown> | null;
  aiState?: string;
}): ConversationsService {
  return {
    findOrCreateByPsid: jest.fn().mockResolvedValue({
      id: 'convo-voice',
      state: over.state ?? null,
      aiState: over.aiState ?? 'bot',
    }),
    addMessage: jest.fn().mockResolvedValue({}),
    findMessageByExternalId: jest.fn().mockResolvedValue(undefined),
    mergeState: jest.fn().mockResolvedValue({}),
    escalateToHuman: jest.fn().mockResolvedValue({}),
  } as unknown as ConversationsService;
}

function buildService(
  conversations: ConversationsService,
  transcription: TranscriptionService,
  triage: TriageService = triageMock,
): AgentService {
  const svc = new AgentService(
    makeConfigMock(),
    productsMock,
    conversations,
    ordersMock,
    agentBehaviorMock,
    knowledgeMock,
    sizingMock,
    visionMock,
    transcription,
    triage,
    stubTenantDb(),
  );
  svc.onModuleInit();
  return svc;
}

/** All addMessage payloads for a given role. */
function loggedRows(
  conversations: ConversationsService,
  role: 'customer' | 'agent',
): Array<Record<string, unknown>> {
  return (conversations.addMessage as jest.Mock).mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((m) => m.role === role);
}

// ---------------------------------------------------------------------------

describe('AgentService — voice-note pre-step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeSalesAgent.generate.mockResolvedValue({ text: 'تمام، لحظة' });
    mockBuildMastra.mockReturnValue({
      mastra: {} as ReturnType<typeof buildMastra>['mastra'],
      salesAgent: fakeSalesAgent as unknown as ReturnType<
        typeof buildMastra
      >['salesAgent'],
      memory: {} as ReturnType<typeof buildMastra>['memory'],
    });
  });

  it('feeds the transcript to generate() and logs marker + audio attributes (happy path)', async () => {
    const conversations = makeConversations({});
    const transcription = makeTranscription(usableVoice());
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(transcription.transcribe).toHaveBeenCalledWith({ url: AUDIO_URL });
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
    expect(fakeSalesAgent.generate.mock.calls[0][0]).toBe(
      'بدي عباية سوداء مقاس 54',
    );
    expect(reply.reply).toBe('تمام، لحظة');
    expect(reply.ran).toBe(true);

    const [customerRow] = loggedRows(conversations, 'customer');
    expect(customerRow.content).toBe(
      `${VOICE_NOTE_MARKER} بدي عباية سوداء مقاس 54`,
    );
    const audio = (customerRow.attributes as { audio: Record<string, unknown> })
      .audio;
    expect(audio.url).toBe(AUDIO_URL);
    expect(audio.transcript).toBe('بدي عباية سوداء مقاس 54');
    expect(audio.usable).toBe(true);
  });

  it('merges typed text and transcript for the model', async () => {
    const conversations = makeConversations({});
    const transcription = makeTranscription(usableVoice());
    const svc = buildService(conversations, transcription);

    await svc.handleMessage({
      contactId: 'C1',
      text: 'مرحبا',
      lastAudioUrl: AUDIO_URL,
    });

    expect(fakeSalesAgent.generate.mock.calls[0][0]).toBe(
      'مرحبا\nبدي عباية سوداء مقاس 54',
    );
  });

  it('resets a non-zero fail counter on a successful voice turn', async () => {
    const conversations = makeConversations({ state: { voiceFailCount: 1 } });
    const transcription = makeTranscription(usableVoice());
    const svc = buildService(conversations, transcription);

    await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(conversations.mergeState).toHaveBeenCalledWith('convo-voice', {
      voiceFailCount: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic degrade flow
  // -------------------------------------------------------------------------

  it('asks for a resend (no generate) on the first unusable voice-only turn', async () => {
    const conversations = makeConversations({});
    const transcription = makeTranscription(unusableVoice('unintelligible'));
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(reply.reply).toBe(VOICE_RETRY_REPLY);
    expect(reply.ran).toBe(true);
    expect(reply.aiState).toBe('bot');
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();
    expect(conversations.mergeState).toHaveBeenCalledWith('convo-voice', {
      voiceFailCount: 1,
    });
    expect(conversations.escalateToHuman).not.toHaveBeenCalled();

    const [customerRow] = loggedRows(conversations, 'customer');
    expect(customerRow.content).toBe(VOICE_FAILED_MARKER);
    const audio = (customerRow.attributes as { audio: Record<string, unknown> })
      .audio;
    expect(audio.reason).toBe('unintelligible');
    expect(audio.failCount).toBe(1);

    const [agentRow] = loggedRows(conversations, 'agent');
    expect(agentRow.content).toBe(VOICE_RETRY_REPLY);
  });

  it('escalates to a human on the second consecutive unusable voice-only turn', async () => {
    const conversations = makeConversations({ state: { voiceFailCount: 1 } });
    const transcription = makeTranscription(unusableVoice('low_confidence'));
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(conversations.escalateToHuman).toHaveBeenCalledWith(
      'convo-voice',
      expect.stringContaining('voice_not_understood: low_confidence'),
    );
    expect(conversations.mergeState).toHaveBeenCalledWith('convo-voice', {
      voiceFailCount: 0,
    });
    expect(reply.reply).toBe(HANDOFF_REPLY);
    expect(reply.aiState).toBe('human');
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();

    const [agentRow] = loggedRows(conversations, 'agent');
    expect(agentRow.content).toBe(HANDOFF_REPLY);
  });

  it('uses the dedicated "too long" reply for oversize/overlong recordings', async () => {
    const conversations = makeConversations({});
    const transcription = makeTranscription(unusableVoice('too_long'));
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(reply.reply).toBe(VOICE_TOO_LONG_REPLY);
  });

  it('runs the full agent on the typed text when the voice note failed but text exists', async () => {
    const conversations = makeConversations({ state: { voiceFailCount: 1 } });
    const transcription = makeTranscription(unusableVoice('model_failed'));
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: 'بدي أسأل عن التوصيل',
      lastAudioUrl: AUDIO_URL,
    });

    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
    expect(fakeSalesAgent.generate.mock.calls[0][0]).toBe(
      'بدي أسأل عن التوصيل',
    );
    expect(reply.reply).toBe('تمام، لحظة');
    // No strike for a turn that still communicated; the counter resets instead.
    expect(conversations.mergeState).toHaveBeenCalledWith('convo-voice', {
      voiceFailCount: 0,
    });
    expect(conversations.escalateToHuman).not.toHaveBeenCalled();

    const [customerRow] = loggedRows(conversations, 'customer');
    expect(customerRow.content).toBe(
      `بدي أسأل عن التوصيل\n${VOICE_FAILED_MARKER}`,
    );
  });

  // -------------------------------------------------------------------------
  // Gate + triage interplay
  // -------------------------------------------------------------------------

  it('still transcribes and logs (then stays silent) when ai_state is not bot', async () => {
    const conversations = makeConversations({ aiState: 'human' });
    const transcription = makeTranscription(usableVoice());
    const svc = buildService(conversations, transcription);

    const reply = await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(transcription.transcribe).toHaveBeenCalledWith({ url: AUDIO_URL });
    expect(reply.reply).toBe('');
    expect(reply.ran).toBe(false);
    expect(fakeSalesAgent.generate).not.toHaveBeenCalled();

    const [customerRow] = loggedRows(conversations, 'customer');
    expect(customerRow.content).toBe(
      `${VOICE_NOTE_MARKER} بدي عباية سوداء مقاس 54`,
    );
    expect(
      (customerRow.attributes as { audio: Record<string, unknown> }).audio.url,
    ).toBe(AUDIO_URL);
  });

  it('never lets triage swallow a voice turn (bails to the full agent)', async () => {
    const conversations = makeConversations({});
    const transcription = makeTranscription(usableVoice());
    const triage = {
      enabled: true,
      match: jest.fn(() => 'greeting'),
      reply: jest.fn(),
      modelId: 'lite',
    } as unknown as TriageService;
    const svc = buildService(conversations, transcription, triage);

    await svc.handleMessage({
      contactId: 'C1',
      text: '',
      lastAudioUrl: AUDIO_URL,
    });

    expect(triage.match).not.toHaveBeenCalled();
    expect(fakeSalesAgent.generate).toHaveBeenCalledTimes(1);
  });
});
