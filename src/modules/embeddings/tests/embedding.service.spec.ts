/**
 * Tests for EmbeddingService.
 *
 * @huggingface/transformers is ESM-only and downloads a multi-hundred-MB model,
 * so it is fully mocked: the fake vision/text models return KNOWN, deliberately
 * UN-normalized vectors. The assertions then prove the service's contract:
 *   - output length === EMBEDDING_DIM (768)
 *   - the returned vector is L2-normalized (its dot product with itself ≈ 1.0)
 * for BOTH embedImage and embedText. (Real model shape/dim is confirmed by the
 * one-off probe documented in the PR; this guards the normalization logic.)
 */

jest.mock('@huggingface/transformers', () => {
  // Constant 768-vectors with non-unit L2 norm (2*sqrt(768) and 3*sqrt(768)).
  // Non-async on purpose: the service awaits these, and `await <value>` is just
  // the value, so plain fns/objects stand in (and avoid the require-await lint).
  const visionModel = jest.fn(() => ({
    image_embeds: { data: new Float32Array(768).fill(2), dims: [1, 768] },
  }));
  const textModel = jest.fn(() => ({
    text_embeds: { data: new Float32Array(768).fill(3), dims: [1, 768] },
  }));
  return {
    env: { allowRemoteModels: false, cacheDir: '' },
    SiglipVisionModel: { from_pretrained: jest.fn(() => visionModel) },
    SiglipTextModel: { from_pretrained: jest.fn(() => textModel) },
    AutoProcessor: {
      from_pretrained: jest.fn(() => jest.fn(() => ({ pixel_values: {} }))),
    },
    AutoTokenizer: {
      from_pretrained: jest.fn(() =>
        jest.fn(() => ({ input_ids: {}, attention_mask: {} })),
      ),
    },
    RawImage: {
      read: jest.fn(() => ({})),
      fromBlob: jest.fn(() => ({})),
    },
  };
});

import { RawImage, SiglipVisionModel } from '@huggingface/transformers';
import { EmbeddingService } from '../embedding.service';
import { ImageDecodeError } from '../image-decode.error';
import type { ConfigService } from '@nestjs/config';

const dot = (a: number[], b: number[]) =>
  a.reduce((sum, x, i) => sum + x * b[i], 0);

describe('EmbeddingService', () => {
  const config = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
  const service = new EmbeddingService(config);

  it('embedImage returns a 768-d, L2-normalized vector (self dot ≈ 1)', async () => {
    const v = await service.embedImage('https://example.com/abaya.jpg');
    expect(v).toHaveLength(768);
    expect(dot(v, v)).toBeCloseTo(1.0, 5);
  });

  it('embedText returns a 768-d, L2-normalized vector (self dot ≈ 1)', async () => {
    const v = await service.embedText('a plain black abaya');
    expect(v).toHaveLength(768);
    expect(dot(v, v)).toBeCloseTo(1.0, 5);
  });

  it('embeds a raw Buffer as well as a URL', async () => {
    const v = await service.embedImage(Buffer.from([1, 2, 3, 4]));
    expect(v).toHaveLength(768);
    expect(dot(v, v)).toBeCloseTo(1.0, 5);
  });

  // --- decode-failure boundary (Part A) ---
  // A buffer/URL that can't be decoded is BAD INPUT: embedImage must reject with
  // the typed ImageDecodeError so the HTTP layer can map it to 422 (not 500).

  it('rejects an undecodable Buffer with ImageDecodeError (decode failure)', async () => {
    (RawImage.fromBlob as jest.Mock).mockRejectedValueOnce(
      new Error('VipsJpeg: Premature end of input file (libspng read error)'),
    );
    await expect(
      service.embedImage(Buffer.from([0xff, 0xd8, 0x00])),
    ).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it('rejects an unreadable image URL with ImageDecodeError (decode failure)', async () => {
    (RawImage.read as jest.Mock).mockRejectedValueOnce(
      new Error('Unable to read image from "https://x/broken.png" (404)'),
    );
    await expect(
      service.embedImage('https://x/broken.png'),
    ).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it('preserves the original decode error as `cause`', async () => {
    const cause = new Error('libspng read error');
    (RawImage.fromBlob as jest.Mock).mockRejectedValueOnce(cause);
    await expect(
      service.embedImage(Buffer.from([0x89, 0x50])),
    ).rejects.toHaveProperty('cause', cause);
  });

  it('loads the model once across multiple calls (lazy singleton)', async () => {
    await service.embedImage('https://example.com/a.jpg');
    await service.embedText('hello');
    expect(
      (SiglipVisionModel.from_pretrained as jest.Mock).mock.calls.length,
    ).toBe(1);
  });

  it('exposes the configured model id (default)', () => {
    expect(service.modelId).toBe('Marqo/marqo-fashionSigLIP');
  });
});
