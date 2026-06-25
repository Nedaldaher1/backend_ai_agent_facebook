// Same ESM stubs as products.service.spec.ts — so the products → storage →
// flydrive (and embeddings → transformers) import chain loads under Jest (CJS).
// All deps are mocked below, so the real modules never run.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
jest.mock('@huggingface/transformers', () => ({
  env: {},
  AutoProcessor: { from_pretrained: jest.fn() },
  AutoTokenizer: { from_pretrained: jest.fn() },
  RawImage: { read: jest.fn(), fromBlob: jest.fn() },
  SiglipTextModel: { from_pretrained: jest.fn() },
  SiglipVisionModel: { from_pretrained: jest.fn() },
}));

import { ProductsService } from '../products.service';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { ColorsService } from '../colors.service';
import type { ProductImageColorsRepository } from '../product-image-colors.repository';
import type { ProductsRepository } from '../products.repository';
import type { ProductImageEmbeddingsRepository } from '../product-image-embeddings.repository';
import type { StorageService } from '@/core/storage/storage.service';
import type { EmbeddingService } from '@/modules/embeddings/embedding.service';
import type { ConfigService } from '@nestjs/config';

/**
 * resolveOrderImageKeyByColor — maps a customer colour term to the FIRST product
 * image (display order) carrying that colour, for order capture. Matching mirrors
 * getProductMediaByColors: dialect/synonym → family, then direct family, then
 * canonical name. Returns null (caller refuses; never falls back to the primary
 * image) when the colour isn't tagged on any current image.
 */
describe('ProductsService.resolveOrderImageKeyByColor', () => {
  const findById = jest.fn();
  const repo = { findById } as unknown as ProductsRepository;

  const resolveColorFamily = jest.fn();
  const colors = { resolveColorFamily } as unknown as ColorSynonymsService;

  const findColorsByProduct = jest.fn();
  const imageColors = {
    findColorsByProduct,
  } as unknown as ProductImageColorsRepository;

  const storage = { getUrl: jest.fn() } as unknown as StorageService;
  const colorsService = {} as unknown as ColorsService;
  const embeddingService = { modelId: 'm' } as unknown as EmbeddingService;
  const embeddings = {} as unknown as ProductImageEmbeddingsRepository;
  const config = { get: jest.fn() } as unknown as ConfigService;

  const service = new ProductsService(
    repo,
    colors,
    storage,
    colorsService,
    imageColors,
    embeddingService,
    embeddings,
    config,
  );

  const PID = 'p1';
  // 3 images, one colour each — the reported-bug product shape.
  const IMAGE_ROWS = [
    { storageKey: 'red.jpg', name: 'أحمر', family: 'red' },
    { storageKey: 'blue.jpg', name: 'ازرق غامق', family: 'dark_blue' },
    { storageKey: 'green.jpg', name: 'أخضر', family: 'green' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    findById.mockResolvedValue({
      id: PID,
      isPublished: true,
      imageUrls: ['red.jpg', 'blue.jpg', 'green.jpg'],
    });
    findColorsByProduct.mockResolvedValue(IMAGE_ROWS);
    resolveColorFamily.mockResolvedValue(null); // no synonym unless a test sets it
  });

  it('matches a canonical Arabic name → that colour image', async () => {
    expect(await service.resolveOrderImageKeyByColor(PID, 'ازرق غامق')).toBe(
      'blue.jpg',
    );
  });

  it('matches a family token (e.g. "green") → that colour image', async () => {
    expect(await service.resolveOrderImageKeyByColor(PID, 'green')).toBe(
      'green.jpg',
    );
  });

  it('matches a dialect synonym via color_synonyms (e.g. نبيتي → red)', async () => {
    resolveColorFamily.mockResolvedValue('red');
    expect(await service.resolveOrderImageKeyByColor(PID, 'نبيتي')).toBe(
      'red.jpg',
    );
  });

  it('ignores a synonym family the product does not carry', async () => {
    resolveColorFamily.mockResolvedValue('gold');
    expect(await service.resolveOrderImageKeyByColor(PID, 'ذهبي')).toBeNull();
  });

  it('returns the FIRST image (display order) when several carry the colour', async () => {
    findById.mockResolvedValue({
      id: PID,
      isPublished: true,
      imageUrls: ['red-a.jpg', 'red-b.jpg'],
    });
    findColorsByProduct.mockResolvedValue([
      { storageKey: 'red-b.jpg', name: 'أحمر', family: 'red' },
      { storageKey: 'red-a.jpg', name: 'أحمر', family: 'red' },
    ]);
    expect(await service.resolveOrderImageKeyByColor(PID, 'أحمر')).toBe(
      'red-a.jpg',
    );
  });

  it('skips stale colour tags whose key is no longer in image_urls', async () => {
    findById.mockResolvedValue({
      id: PID,
      isPublished: true,
      imageUrls: ['blue.jpg'], // red.jpg removed from the product
    });
    findColorsByProduct.mockResolvedValue([
      { storageKey: 'red.jpg', name: 'أحمر', family: 'red' }, // stale
      { storageKey: 'blue.jpg', name: 'ازرق غامق', family: 'dark_blue' },
    ]);
    expect(await service.resolveOrderImageKeyByColor(PID, 'أحمر')).toBeNull();
    expect(await service.resolveOrderImageKeyByColor(PID, 'ازرق غامق')).toBe(
      'blue.jpg',
    );
  });

  it('returns null for an empty term (no DB read)', async () => {
    expect(await service.resolveOrderImageKeyByColor(PID, '   ')).toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('returns null for a product with no colour tags', async () => {
    findColorsByProduct.mockResolvedValue([]);
    expect(await service.resolveOrderImageKeyByColor(PID, 'أحمر')).toBeNull();
  });

  it('returns null for a missing / unpublished product (no throw)', async () => {
    findById.mockResolvedValue(undefined);
    expect(await service.resolveOrderImageKeyByColor(PID, 'أحمر')).toBeNull();
  });
});
