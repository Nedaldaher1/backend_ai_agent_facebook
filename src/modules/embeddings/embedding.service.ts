import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** OpenRouter /embeddings `input` shapes (OpenAI-compatible + the multimodal
 *  content-array extension that carries images alongside text). */
type EmbedInput =
  | string
  | Array<{
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    }>;

/**
 * Multimodal embeddings via OpenRouter's OpenAI-compatible `/embeddings`
 * endpoint (model `google/gemini-embedding-2`). `embedText`, `embedImage`, and
 * `embedImageWithText` all return an L2-normalized, `EMBEDDING_DIM`-length vector
 * in ONE unified space, so cosine similarity (pgvector `<=>`) is meaningful
 * across text, image, and image+text.
 *
 * Pure HTTP: NO database and NO feature-module imports — the products module
 * wraps this with storage + persistence. Images are passed as PUBLIC URLs (R2
 * product images; the customer's image URL at query time) and fetched
 * server-side by OpenRouter; we never download bytes here.
 *
 * The model id is a config knob (`EMBEDDING_MODEL_ID`) and is persisted with
 * each embedding (`model_id` column) so a model swap is detected and re-embedded.
 * Embedding spaces are NOT compatible across models — a swap requires a full
 * re-backfill.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /** The model/version producing the vectors — persisted with each embedding. */
  readonly modelId: string;
  private readonly dim: number;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ConfigService) {
    this.modelId =
      config.get<string>('EMBEDDING_MODEL_ID') ?? 'google/gemini-embedding-2';
    this.dim = Number(config.get<string>('EMBEDDING_DIM') ?? '1536');
    this.apiUrl =
      config.get<string>('EMBEDDING_API_URL') ??
      'https://openrouter.ai/api/v1/embeddings';
    this.apiKey = config.get<string>('OPENROUTER_API_KEY') ?? '';
    this.timeoutMs = Number(
      config.get<string>('EMBEDDING_TIMEOUT_MS') ?? '15000',
    );
    this.maxRetries = Number(
      config.get<string>('EMBEDDING_MAX_RETRIES') ?? '2',
    );
  }

  /** Embed text → L2-normalized vector. */
  async embedText(text: string): Promise<number[]> {
    return this.embedRequest(text);
  }

  /** Embed an image (public URL) → L2-normalized vector in the same space. */
  async embedImage(imageUrl: string): Promise<number[]> {
    return this.embedRequest([
      { content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
    ]);
  }

  /**
   * Embed an image (public URL) TOGETHER WITH a text description → ONE
   * L2-normalized vector carrying both. Used for product images (with the
   * admin-authored description) and for a customer image sent with a caption.
   */
  async embedImageWithText(imageUrl: string, text: string): Promise<number[]> {
    return this.embedRequest([
      {
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ]);
  }

  /** POST to the embeddings endpoint with timeout + retry; parse + normalize. */
  private async embedRequest(input: EmbedInput): Promise<number[]> {
    const body = JSON.stringify({
      model: this.modelId,
      input,
      // OpenAI-compatible dimension request (Matryoshka). If the provider ignores
      // it and returns more, `normalize` truncates back to EMBEDDING_DIM.
      dimensions: this.dim,
      encoding_format: 'float',
    });

    let lastError = '';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Network error or timeout — transient, retry.
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`EmbeddingService: request failed — ${lastError}`);
      }

      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < this.maxRetries
      ) {
        lastError = `HTTP ${res.status}`;
        await this.backoff(attempt);
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `EmbeddingService: ${this.modelId} returned ${res.status}: ${detail.slice(0, 300)}`,
        );
      }

      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const raw = json.data?.[0]?.embedding;
      if (!raw || raw.length === 0) {
        throw new Error('EmbeddingService: response contained no embedding');
      }
      return this.normalize(raw);
    }

    throw new Error(`EmbeddingService: exhausted retries — ${lastError}`);
  }

  /** Exponential backoff between retries (250ms, 500ms, …). */
  private backoff(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }

  /**
   * Truncate to `EMBEDDING_DIM` (Matryoshka: a higher-dim vector can be cut to a
   * lower dim and renormalized) then L2-normalize, so cosine == dot product and
   * the length matches the pgvector column.
   */
  private normalize(raw: number[]): number[] {
    if (raw.length < this.dim) {
      throw new Error(
        `EmbeddingService: expected >= ${this.dim}-d embedding, got ${raw.length}`,
      );
    }
    const vec = raw.length === this.dim ? raw : raw.slice(0, this.dim);
    let sumSq = 0;
    for (const x of vec) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    // A zero vector can't be normalized — return as-is rather than divide by 0.
    return norm === 0 ? vec : vec.map((x) => x / norm);
  }
}
