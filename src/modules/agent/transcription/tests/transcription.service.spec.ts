/**
 * Unit tests for TranscriptionService. The real model call cannot run in dev
 * (the OPENROUTER_API_KEY is a placeholder → 401), so the Mastra Agent is
 * mocked; we assert the request shape (base64 `file` part — never a raw http
 * URL — + structuredOutput) and, above all, the graceful-degradation contract:
 * transcribe NEVER throws.
 */

// Module-level mocks (referenced from the jest.mock factories — names must
// start with `mock` to satisfy jest hoisting).
const mockGenerate = jest.fn();
const mockDownloadAudio = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({ generate: mockGenerate })),
}));
// Keep the REAL error classes (the service instanceof-checks them) and stub
// only the network-touching function.
jest.mock('../audio-download.util', () => {
  const actual = jest.requireActual<typeof import('../audio-download.util')>(
    '../audio-download.util',
  );
  return {
    ...actual,
    downloadAudio: (...args: unknown[]): unknown => mockDownloadAudio(...args),
  };
});

import { TranscriptionService } from '../transcription.service';
import {
  AudioFetchError,
  AudioTooLargeError,
  AudioUnsupportedError,
} from '../audio-download.util';
import type { ConfigService } from '@nestjs/config';

const FULL_OUTPUT = {
  transcript: 'بدي عباية سوداء مقاس 54',
  normalizedText: null,
  language: 'ar-JO',
  confidence: 0.9,
  intelligible: true,
  reason: null,
};

function makeService(configOverrides: Record<string, string> = {}) {
  const config = {
    get: (k: string) =>
      ({ TRANSCRIPTION_ENABLED: 'true', ...configOverrides })[k],
  } as unknown as ConfigService;
  return new TranscriptionService(config);
}

describe('TranscriptionService.transcribe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerate.mockReset();
    mockDownloadAudio.mockReset();
    mockDownloadAudio.mockResolvedValue({
      buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]),
      mediaType: 'audio/mp4',
      durationSec: 12,
    });
  });

  it('returns a usable transcript on the happy path', async () => {
    mockGenerate.mockResolvedValue({ object: FULL_OUTPUT });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/v.mp4' });

    expect(res.ok).toBe(true);
    expect(res.transcript).toBe(FULL_OUTPUT.transcript);
    expect(res.language).toBe('ar-JO');
    expect(res.confidence).toBe(0.9);
    expect(res.reason).toBeUndefined();
    expect(res.meta.durationSec).toBe(12);
  });

  it('sends a base64 file part (never a raw URL) and a structuredOutput schema', async () => {
    mockGenerate.mockResolvedValue({ object: FULL_OUTPUT });
    const service = makeService();

    await service.transcribe({ url: 'https://cdn/v.mp4' });

    const [messages, options] = mockGenerate.mock.calls[0] as [
      Array<{ content: Array<{ type: string; data?: string }> }>,
      { structuredOutput: { schema: unknown } },
    ];
    expect(options.structuredOutput.schema).toBeDefined();
    const filePart = messages[0].content.find((p) => p.type === 'file');
    expect(filePart?.data).toContain('data:audio/mp4;base64,');
    expect(filePart?.data).not.toContain('https://');
  });

  it('falls back to parsing JSON text when the result has no .object', async () => {
    mockGenerate.mockResolvedValue({ text: JSON.stringify(FULL_OUTPUT) });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/v.mp4' });

    expect(res.ok).toBe(true);
    expect(res.transcript).toBe(FULL_OUTPUT.transcript);
  });

  it('is a no-op unless explicitly enabled (opt-in flag)', async () => {
    const service = makeService({ TRANSCRIPTION_ENABLED: 'nope' });

    const res = await service.transcribe({ url: 'https://cdn/v.mp4' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('disabled');
    expect(mockDownloadAudio).not.toHaveBeenCalled();
  });

  it('degrades (never throws) when the audio fetch fails', async () => {
    mockDownloadAudio.mockRejectedValue(new AudioFetchError('boom'));
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('fetch_failed');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('maps an oversize recording to too_large', async () => {
    mockDownloadAudio.mockRejectedValue(new AudioTooLargeError('big'));
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.reason).toBe('too_large');
  });

  it('maps an unsupported format to unsupported_format', async () => {
    mockDownloadAudio.mockRejectedValue(new AudioUnsupportedError('webm'));
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.reason).toBe('unsupported_format');
  });

  it('refuses a recording longer than the duration cap without calling the model', async () => {
    mockDownloadAudio.mockResolvedValue({
      buffer: Buffer.from([0x00]),
      mediaType: 'audio/mp4',
      durationSec: 400,
    });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/long' });

    expect(res.reason).toBe('too_long');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('degrades when the model call throws', async () => {
    mockGenerate.mockRejectedValue(new Error('500'));
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('model_failed');
  });

  it('degrades when the model output fails schema validation', async () => {
    mockGenerate.mockResolvedValue({ object: { foo: 'bar' } });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.reason).toBe('model_failed');
  });

  it('marks a not-intelligible recording (model judgment) as unusable', async () => {
    mockGenerate.mockResolvedValue({
      object: {
        ...FULL_OUTPUT,
        transcript: '',
        intelligible: false,
        confidence: 0.2,
        reason: 'ضجيج',
      },
    });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/noise' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unintelligible');
  });

  it('marks an empty transcript as unintelligible even when flagged intelligible', async () => {
    mockGenerate.mockResolvedValue({
      object: { ...FULL_OUTPUT, transcript: '   ' },
    });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/empty' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unintelligible');
  });

  it('flags low confidence as unusable but keeps the transcript for the log', async () => {
    mockGenerate.mockResolvedValue({
      object: { ...FULL_OUTPUT, confidence: 0.2 },
    });
    const service = makeService();

    const res = await service.transcribe({ url: 'https://cdn/mumble' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('low_confidence');
    expect(res.transcript).toBe(FULL_OUTPUT.transcript);
  });

  it('honors a configured confidence floor', async () => {
    mockGenerate.mockResolvedValue({
      object: { ...FULL_OUTPUT, confidence: 0.5 },
    });
    const service = makeService({ TRANSCRIPTION_MIN_CONFIDENCE: '0.8' });

    const res = await service.transcribe({ url: 'https://cdn/x' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('low_confidence');
  });
});
