/**
 * Unit tests for VisionService. The real Claude call cannot run in dev (the
 * ANTHROPIC_API_KEY is a placeholder → 401), so the Mastra Agent is mocked; we
 * assert the request shape (image part + structuredOutput) and, above all, the
 * graceful-degradation contract: extractAttributes NEVER throws.
 */

// Module-level mocks (referenced from the jest.mock factories — names must start
// with `mock` to satisfy jest hoisting).
const mockGenerate = jest.fn();
const mockDownloadImage = jest.fn();

// Heavy/ESM transitive deps pulled in via ProductsService — stub so the module
// graph loads under Jest (CJS), mirroring the other agent specs.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
jest.mock('@huggingface/transformers', () => ({
  AutoProcessor: { from_pretrained: jest.fn() },
  AutoTokenizer: { from_pretrained: jest.fn() },
  RawImage: { read: jest.fn(), fromBlob: jest.fn() },
  SiglipTextModel: { from_pretrained: jest.fn() },
  SiglipVisionModel: { from_pretrained: jest.fn() },
  env: {},
}));
jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({ generate: mockGenerate })),
}));
jest.mock('../image-download.util', () => ({
  downloadImage: (...args: unknown[]) => mockDownloadImage(...args),
  ImageFetchError: class ImageFetchError extends Error {},
}));

import { VisionService } from '../vision.service';
import type { ConfigService } from '@nestjs/config';
import type { ProductsService } from '@/modules/products/products.service';
import type { ColorsService } from '@/modules/products/colors.service';
import type { SizingService } from '@/modules/sizing/sizing.service';

// color is a value from the closed enum the schema is built with (['red','black']),
// since the model is constrained to pick a canonical family from that list.
const FULL_ATTRS = {
  isAbaya: true,
  confidence: 0.9,
  color: 'red',
  size: null,
  occasion: 'سهرة',
  fabric: null,
  sleeveType: null,
  embellishment: null,
};

function makeService(configOverrides: Record<string, string> = {}) {
  const products = {
    normalizeColor: jest.fn().mockResolvedValue('red'),
    distinctPublishedAttribute: jest.fn().mockResolvedValue([]),
  } as unknown as ProductsService;
  const colors = {
    listActiveFamilies: jest.fn().mockResolvedValue(['red', 'black']),
  } as unknown as ColorsService;
  const sizing = {
    listSizeCodes: jest.fn().mockResolvedValue(['1', '2']),
  } as unknown as SizingService;
  const config = {
    get: (k: string) => configOverrides[k],
  } as unknown as ConfigService;
  const service = new VisionService(config, products, colors, sizing);
  return { service, products, colors, sizing };
}

describe('VisionService.extractAttributes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerate.mockReset();
    mockDownloadImage.mockReset();
    mockDownloadImage.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      mediaType: 'image/jpeg',
    });
  });

  it('returns normalized attributes on the happy path', async () => {
    mockGenerate.mockResolvedValue({ object: FULL_ATTRS });
    const { service, products } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/a.jpg' });

    expect(res.attributes).not.toBeNull();
    expect(res.attributes?.colorFamily).toBe('red');
    expect(res.confidence).toBe(0.9);
    expect(res.reason).toBeUndefined();
    expect(products.normalizeColor).toHaveBeenCalledWith('red');
  });

  it('sends a base64 image part and a structuredOutput schema to the model', async () => {
    mockGenerate.mockResolvedValue({ object: FULL_ATTRS });
    const { service } = makeService();

    await service.extractAttributes({ url: 'https://cdn/a.jpg' });

    const [messages, options] = mockGenerate.mock.calls[0];
    expect(options.structuredOutput.schema).toBeDefined();
    const parts = messages[0].content as Array<{ type: string; image?: string }>;
    const imagePart = parts.find((p) => p.type === 'image');
    expect(imagePart?.image).toContain('data:image/jpeg;base64,');
  });

  it('falls back to parsing JSON text when the result has no .object', async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({ ...FULL_ATTRS, confidence: 0.7 }),
    });
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/a.jpg' });

    expect(res.attributes?.colorFamily).toBe('red');
    expect(res.reason).toBeUndefined();
  });

  it('degrades (never throws) when the image fetch fails', async () => {
    mockDownloadImage.mockRejectedValue(new Error('boom'));
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.attributes).toBeNull();
    expect(res.reason).toBe('fetch_failed');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('degrades when the model call throws', async () => {
    mockGenerate.mockRejectedValue(new Error('500'));
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.attributes).toBeNull();
    expect(res.reason).toBe('model_failed');
  });

  it('degrades when the model output fails schema validation', async () => {
    mockGenerate.mockResolvedValue({ object: { foo: 'bar' } });
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.attributes).toBeNull();
    expect(res.reason).toBe('model_failed');
  });

  it('returns no attributes when the image is not a product', async () => {
    mockGenerate.mockResolvedValue({
      object: { ...FULL_ATTRS, isAbaya: false },
    });
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.attributes).toBeNull();
    expect(res.reason).toBe('not_a_product');
  });

  it('flags low confidence but still surfaces the attributes', async () => {
    mockGenerate.mockResolvedValue({
      object: { ...FULL_ATTRS, confidence: 0.2 },
    });
    const { service } = makeService();

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.attributes).not.toBeNull();
    expect(res.reason).toBe('low_confidence');
  });

  it('is a no-op when disabled via config', async () => {
    const { service } = makeService({ VISION_ENABLED: 'false' });

    const res = await service.extractAttributes({ url: 'https://cdn/x' });

    expect(res.reason).toBe('disabled');
    expect(mockDownloadImage).not.toHaveBeenCalled();
  });

  it('caches the catalog enums across calls within the TTL', async () => {
    mockGenerate.mockResolvedValue({ object: FULL_ATTRS });
    const { service, colors } = makeService();

    await service.extractAttributes({ url: 'https://cdn/a.jpg' });
    await service.extractAttributes({ url: 'https://cdn/b.jpg' });

    expect(colors.listActiveFamilies).toHaveBeenCalledTimes(1);
  });
});
