import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  SiglipTextModel,
  SiglipVisionModel,
  env,
} from '@huggingface/transformers';
import { ImageDecodeError } from './image-decode.error';

export type EmbeddingDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4';

/** Minimal shape of a Transformers.js output tensor (flattened `data`). */
interface EmbedTensor {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}
type VisionFn = (inputs: unknown) => Promise<{ image_embeds?: EmbedTensor }>;
type TextFn = (inputs: unknown) => Promise<{ text_embeds?: EmbedTensor }>;
type ProcessorFn = (image: unknown) => Promise<unknown>;
type TokenizerFn = (
  texts: string[],
  opts: { padding: 'max_length'; truncation: boolean },
) => unknown;

interface LoadedModel {
  vision: VisionFn;
  text: TextFn;
  processor: ProcessorFn;
  tokenizer: TokenizerFn;
}

/**
 * In-process multimodal embeddings (Marqo-FashionSigLIP via Transformers.js +
 * onnxruntime-node). Pure inference: NO database and NO feature-module imports —
 * the products module wraps this with storage + persistence.
 *
 * `embedImage` and `embedText` both return an L2-NORMALIZED, `EMBEDDING_DIM`-length
 * vector in the SAME space, so cosine similarity (pgvector `<=>`) is meaningful.
 * Verified empirically: the model id is `image_embeds` / `text_embeds`, dim 768,
 * and the raw outputs are NOT normalized (L2 ≈ 17–20) — so normalizing here is
 * mandatory, not cosmetic.
 *
 * The model loads once, lazily, on first use (boot stays fast; a deploy that
 * never touches visual search pays nothing). Forward passes are serialized
 * through a promise-chain mutex: two CPU-bound passes in parallel just thrash the
 * CPU at our volume. The dtype is a single config knob so catalog and query
 * embeddings always match (mixing dtypes degrades recall).
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /** The model/version producing the vectors — persisted with each embedding. */
  readonly modelId: string;
  private readonly dim: number;
  private readonly dtype: EmbeddingDtype;
  private readonly cacheDir: string;
  private loaded?: Promise<LoadedModel>;
  /** Tail of the inference queue (concurrency 1); no external dependency. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(config: ConfigService) {
    this.modelId =
      config.get<string>('EMBEDDING_MODEL_ID') ?? 'Marqo/marqo-fashionSigLIP';
    this.dim = config.get<number>('EMBEDDING_DIM') ?? 768;
    this.dtype = (config.get<string>('EMBEDDING_DTYPE') ??
      'fp32') as EmbeddingDtype;
    this.cacheDir =
      config.get<string>('TRANSFORMERS_CACHE_DIR') ?? './.cache/transformers';
  }

  /**
   * Embed an image (public URL or raw bytes) → L2-normalized vector.
   *
   * Only the decode step is guarded: bytes that can't be read/decoded
   * (corrupt/unsupported image — sharp/libspng throws here) are a CLIENT
   * problem, surfaced as {@link ImageDecodeError} for the HTTP layer to map to
   * 422. The model forward pass stays OUTSIDE the guard so a genuine inference
   * fault propagates as a real server error (500), not a masked 422.
   */
  async embedImage(input: string | Buffer): Promise<number[]> {
    const { vision, processor } = await this.ensureLoaded();
    return this.serialize(async () => {
      let image: RawImage;
      try {
        image =
          typeof input === 'string'
            ? await RawImage.read(input)
            : await RawImage.fromBlob(new Blob([new Uint8Array(input)]));
      } catch (err) {
        throw new ImageDecodeError('image could not be decoded', {
          cause: err,
        });
      }
      const inputs = await processor(image);
      const output = await vision(inputs);
      return this.normalize(output.image_embeds, 'image');
    });
  }

  /** Embed text → L2-normalized vector in the SAME space as embedImage. */
  async embedText(text: string): Promise<number[]> {
    const { text: textModel, tokenizer } = await this.ensureLoaded();
    return this.serialize(async () => {
      const inputs = tokenizer([text], {
        padding: 'max_length',
        truncation: true,
      });
      const output = await textModel(inputs);
      return this.normalize(output.text_embeds, 'text');
    });
  }

  private ensureLoaded(): Promise<LoadedModel> {
    if (!this.loaded) this.loaded = this.load();
    return this.loaded;
  }

  private async load(): Promise<LoadedModel> {
    env.allowRemoteModels = true;
    env.cacheDir = this.cacheDir;
    this.logger.log(
      `loading ${this.modelId} (dtype=${this.dtype}) from cache ${this.cacheDir} …`,
    );
    const startedAt = Date.now();
    const [vision, text, processor, tokenizer] = await Promise.all([
      SiglipVisionModel.from_pretrained(this.modelId, { dtype: this.dtype }),
      SiglipTextModel.from_pretrained(this.modelId, { dtype: this.dtype }),
      AutoProcessor.from_pretrained(this.modelId),
      AutoTokenizer.from_pretrained(this.modelId),
    ]);
    this.logger.log(`model ready in ${Date.now() - startedAt}ms`);
    return {
      vision: vision as unknown as VisionFn,
      text: text as unknown as TextFn,
      processor: processor as unknown as ProcessorFn,
      tokenizer: tokenizer as unknown as TokenizerFn,
    };
  }

  /** Run `task` only after all previously-queued tasks settle (concurrency 1). */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // Keep the chain alive regardless of this task's success/failure.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** L2-normalize, asserting the dimension matches EMBEDDING_DIM (768). */
  private normalize(tensor: EmbedTensor | undefined, kind: string): number[] {
    if (!tensor?.data) {
      throw new Error(`EmbeddingService: model returned no ${kind} embedding`);
    }
    const vec = Array.from(tensor.data, Number);
    if (vec.length !== this.dim) {
      throw new Error(
        `EmbeddingService: expected ${this.dim}-d ${kind} embedding, got ${vec.length}`,
      );
    }
    let sumSq = 0;
    for (const x of vec) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    // A zero vector can't be normalized — return as-is rather than divide by 0.
    return norm === 0 ? vec : vec.map((x) => x / norm);
  }
}
