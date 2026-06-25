/**
 * Tests for EmbeddingService.
 *
 * The service POSTs to OpenRouter's OpenAI-compatible `/embeddings` endpoint, so
 * `fetch` is mocked. The assertions prove its contract: the request body shape
 * for text / image / image+text, truncation to EMBEDDING_DIM + L2-normalization,
 * and the retry / error behavior.
 */

import { EmbeddingService } from '../embedding.service';
import type { ConfigService } from '@nestjs/config';

const dot = (a: number[], b: number[]) =>
  a.reduce((sum, x, i) => sum + x * b[i], 0);

/** A ConfigService stub with small dims/timeouts for fast tests. */
function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    EMBEDDING_MODEL_ID: 'google/gemini-embedding-2',
    EMBEDDING_DIM: '4',
    EMBEDDING_API_URL: 'https://openrouter.test/api/v1/embeddings',
    OPENROUTER_API_KEY: 'sk-or-test',
    EMBEDDING_TIMEOUT_MS: '1000',
    EMBEDDING_MAX_RETRIES: '2',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/** A fake fetch Response carrying `data[0].embedding`. */
function embeddingResponse(vec: number[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data: [{ embedding: vec }] }),
    text: () => Promise.resolve('error body'),
  } as unknown as Response;
}

describe('EmbeddingService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('embedText posts the text input and returns an L2-normalized vector', async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse([2, 0, 0, 0]));
    const service = new EmbeddingService(makeConfig());

    const v = await service.embedText('a plain black abaya');

    expect(v).toHaveLength(4);
    expect(dot(v, v)).toBeCloseTo(1.0, 5);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.test/api/v1/embeddings');
    const body = JSON.parse(init.body as string) as {
      model: string;
      input: unknown;
      dimensions: number;
    };
    expect(body.model).toBe('google/gemini-embedding-2');
    expect(body.input).toBe('a plain black abaya');
    expect(body.dimensions).toBe(4);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-or-test',
    );
  });

  it('embedImage posts a single image_url content part', async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse([0, 3, 0, 0]));
    const service = new EmbeddingService(makeConfig());

    await service.embedImage('https://cdn/abaya.jpg');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: unknown };
    expect(body.input).toEqual([
      {
        content: [
          { type: 'image_url', image_url: { url: 'https://cdn/abaya.jpg' } },
        ],
      },
    ]);
  });

  it('embedImageWithText posts both a text and an image_url part', async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse([1, 1, 1, 1]));
    const service = new EmbeddingService(makeConfig());

    await service.embedImageWithText('https://cdn/a.jpg', 'red floral abaya');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { input: unknown };
    expect(body.input).toEqual([
      {
        content: [
          { type: 'text', text: 'red floral abaya' },
          { type: 'image_url', image_url: { url: 'https://cdn/a.jpg' } },
        ],
      },
    ]);
  });

  it('truncates an over-long embedding to EMBEDDING_DIM then normalizes (MRL)', async () => {
    // Provider returns 6 dims; the service must cut to 4 and renormalize.
    fetchMock.mockResolvedValueOnce(embeddingResponse([2, 0, 0, 0, 9, 9]));
    const service = new EmbeddingService(makeConfig());

    const v = await service.embedText('x');

    expect(v).toHaveLength(4);
    expect(dot(v, v)).toBeCloseTo(1.0, 5);
  });

  it('retries on a 429 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(embeddingResponse([], 429))
      .mockResolvedValueOnce(embeddingResponse([1, 0, 0, 0]));
    const service = new EmbeddingService(makeConfig());

    const v = await service.embedText('x');

    expect(v).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on persistent 5xx', async () => {
    fetchMock.mockResolvedValue(embeddingResponse([], 503));
    const service = new EmbeddingService(
      makeConfig({ EMBEDDING_MAX_RETRIES: '1' }),
    );

    await expect(service.embedText('x')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('throws immediately on a non-retryable 4xx', async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse([], 400));
    const service = new EmbeddingService(makeConfig());

    await expect(service.embedText('x')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes the configured model id', () => {
    expect(new EmbeddingService(makeConfig()).modelId).toBe(
      'google/gemini-embedding-2',
    );
  });
});
