// flydrive is ESM-only and isolated inside StorageService; stub it so importing
// the products -> storage chain doesn't load the real module under Jest (CJS).
// This spec injects a mock StorageService, so the stubs are never exercised.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));
// EmbeddingService is pulled in (for DI metadata) via ProductsService and imports
// @huggingface/transformers, which is ESM-only; stub it so the chain loads under
// Jest (CJS). A mock EmbeddingService is injected, so the real one never runs.
jest.mock('@huggingface/transformers', () => ({
  env: {},
  AutoProcessor: { from_pretrained: jest.fn() },
  AutoTokenizer: { from_pretrained: jest.fn() },
  RawImage: { read: jest.fn(), fromBlob: jest.fn() },
  SiglipTextModel: { from_pretrained: jest.fn() },
  SiglipVisionModel: { from_pretrained: jest.fn() },
}));

import {
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ProductsService } from '../products.service';
import { ImageDecodeError } from '@/modules/embeddings/image-decode.error';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { ColorsService } from '../colors.service';
import type { ProductImageColorsRepository } from '../product-image-colors.repository';
import type { ProductsRepository } from '../products.repository';
import type { ProductImageEmbeddingsRepository } from '../product-image-embeddings.repository';
import type { StorageService } from '@/core/storage/storage.service';
import type { EmbeddingService } from '@/modules/embeddings/embedding.service';
import type { ConfigService } from '@nestjs/config';

// Real uuids — setImageColorsSchema validates colorIds with z.uuid().
const RED = '11111111-1111-4111-8111-111111111111';
const GHOST = '99999999-9999-4999-8999-999999999999';

const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'عباءة زرقاء',
  priceJod: '45.000',
  colorFamily: 'blue',
  colorShade: null,
  sleeveType: null,
  fabric: null,
  embellishment: null,
  occasion: null,
  sizes: [],
  stockStatus: 'in_stock' as const,
  imageUrls: [],
  tags: [],
  attributes: null,
  isPublished: true,
  sku: null,
  description: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ProductsService', () => {
  const resolveColorFamily = jest.fn();
  const list = jest.fn();
  const count = jest.fn();
  const findById = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const deleteById = jest.fn();
  const setPublished = jest.fn();
  const appendImageUrls = jest.fn();

  const repo = {
    list,
    count,
    findById,
    insert,
    updateById,
    deleteById,
    setPublished,
    appendImageUrls,
  } as unknown as ProductsRepository;

  const colors = {
    resolveColorFamily,
  } as unknown as ColorSynonymsService;

  const saveImage = jest.fn();
  const deleteImage = jest.fn();
  const getUrl = jest.fn();
  const storage = {
    saveImage,
    deleteImage,
    getUrl,
  } as unknown as StorageService;

  const getColorById = jest.fn();
  const getManyByIds = jest.fn();
  const colorsService = {
    getById: getColorById,
    getManyByIds,
  } as unknown as ColorsService;

  const findColorsByProduct = jest.fn();
  const replaceForImage = jest.fn();
  const deleteForImage = jest.fn();
  const imageColors = {
    findColorsByProduct,
    replaceForImage,
    deleteForImage,
  } as unknown as ProductImageColorsRepository;

  const embedImage = jest.fn();
  const embeddingService = {
    modelId: 'test-model',
    embedImage,
  } as unknown as EmbeddingService;

  const upsertEmbedding = jest.fn();
  const deleteMissingKeys = jest.fn();
  const findEmbeddedKeys = jest.fn();
  const countEmbeddedByProduct = jest.fn();
  const searchSimilarByEmbedding = jest.fn();
  const embeddings = {
    upsert: upsertEmbedding,
    deleteMissingKeys,
    findEmbeddedKeys,
    countEmbeddedByProduct,
    searchSimilarByEmbedding,
    count: jest.fn(),
  } as unknown as ProductImageEmbeddingsRepository;

  const configGet = jest.fn();
  const config = { get: configGet } as unknown as ConfigService;

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

  beforeEach(() => {
    jest.clearAllMocks();
    list.mockResolvedValue([]);
    count.mockResolvedValue(0);
    // Default: getUrl echoes key as a public URL so resolution is traceable.
    getUrl.mockImplementation((key: string) =>
      Promise.resolve(`https://pub.example.com/${key}`),
    );
    // Default: no image-color tags / writes succeed unless a test overrides.
    findColorsByProduct.mockResolvedValue([]);
    replaceForImage.mockResolvedValue(undefined);
    deleteForImage.mockResolvedValue(undefined);
    // Embedding write-path/search: clean no-op defaults so the fire-and-forget
    // sync fired by create/publish/image changes never rejects during a test.
    embedImage.mockResolvedValue(new Array(768).fill(0));
    upsertEmbedding.mockResolvedValue(undefined);
    deleteMissingKeys.mockResolvedValue(0);
    findEmbeddedKeys.mockResolvedValue([]);
    countEmbeddedByProduct.mockResolvedValue([]);
    searchSimilarByEmbedding.mockResolvedValue([]);
    configGet.mockReturnValue(undefined);
  });

  // --- existing cases (kept) ---

  it('normalizes a dialect color term to its family before searching', async () => {
    resolveColorFamily.mockResolvedValue('red');

    await service.search({ color: 'نبيتي' });

    expect(resolveColorFamily).toHaveBeenCalledWith('نبيتي');
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ colorFamily: 'red', isPublished: true }),
    );
  });

  it('passes an explicit colorFamily through without a synonym lookup', async () => {
    await service.search({ colorFamily: 'blue' });

    expect(resolveColorFamily).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ colorFamily: 'blue', isPublished: true }),
    );
  });

  it('search resolves image_urls keys to public URLs (GET /products boundary)', async () => {
    list.mockResolvedValue([makeProduct({ imageUrls: ['k1.jpg', 'k2.png'] })]);

    const [product] = await service.search({ colorFamily: 'blue' });

    expect(product.imageUrls).toEqual([
      'https://pub.example.com/k1.jpg',
      'https://pub.example.com/k2.png',
    ]);
    expect(getUrl).toHaveBeenCalledWith('k1.jpg');
    expect(getUrl).toHaveBeenCalledWith('k2.png');
  });

  it('throws when an unpublished product is requested by id', async () => {
    findById.mockResolvedValue({ id: 'x', isPublished: false });

    await expect(service.getPublishedById('x')).rejects.toThrow('not found');
  });

  // --- listPublished forces isPublished: true ---

  it('listPublished always forces isPublished: true into the filter', async () => {
    await service.listPublished({ colorFamily: 'green' });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true, colorFamily: 'green' }),
      undefined,
    );
  });

  it('listPublished with no args still forces isPublished: true', async () => {
    await service.listPublished();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true }),
      undefined,
    );
  });

  // --- getPublishedById ---

  it('getPublishedById returns the product when it is published (resolves image URLs)', async () => {
    const product = makeProduct({
      id: 'pub-1',
      isPublished: true,
      imageUrls: ['k1.jpg', 'k2.png'],
    });
    findById.mockResolvedValue(product);

    const result = await service.getPublishedById('pub-1');

    // Keys should be replaced by resolved URLs at this boundary.
    expect(result.imageUrls).toEqual([
      'https://pub.example.com/k1.jpg',
      'https://pub.example.com/k2.png',
    ]);
    expect(getUrl).toHaveBeenCalledWith('k1.jpg');
    expect(getUrl).toHaveBeenCalledWith('k2.png');
  });

  it('getPublishedById throws NotFoundException when the product does not exist', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getPublishedById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- togglePublish ---

  it('togglePublish reads current state then flips published -> unpublished', async () => {
    const current = makeProduct({ id: 't1', isPublished: true });
    const updated = makeProduct({ id: 't1', isPublished: false });
    findById.mockResolvedValue(current);
    setPublished.mockResolvedValue(updated);

    const result = await service.togglePublish('t1');

    expect(findById).toHaveBeenCalledWith('t1');
    expect(setPublished).toHaveBeenCalledWith('t1', false);
    expect(result.isPublished).toBe(false);
  });

  it('togglePublish flips unpublished -> published', async () => {
    const current = makeProduct({ id: 't2', isPublished: false });
    const updated = makeProduct({ id: 't2', isPublished: true });
    findById.mockResolvedValue(current);
    setPublished.mockResolvedValue(updated);

    const result = await service.togglePublish('t2');

    expect(setPublished).toHaveBeenCalledWith('t2', true);
    expect(result.isPublished).toBe(true);
  });

  it('togglePublish throws NotFoundException when the product is missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.togglePublish('ghost')).rejects.toThrow(
      NotFoundException,
    );
    expect(setPublished).not.toHaveBeenCalled();
  });

  // --- assertWritable via create ---

  it('create throws BadRequestException for a price with too many decimals', () => {
    expect(() =>
      service.create({
        name: 'X',
        priceJod: '1.2345',
        stockStatus: 'in_stock',
      }),
    ).toThrow(BadRequestException);
  });

  it('create throws BadRequestException for a non-numeric price', () => {
    expect(() =>
      service.create({ name: 'X', priceJod: 'abc', stockStatus: 'in_stock' }),
    ).toThrow(BadRequestException);
  });

  it('create throws BadRequestException for an invalid stockStatus', () => {
    expect(() =>
      service.create({
        name: 'X',
        priceJod: '10.000',
        stockStatus: 'unknown_status',
      }),
    ).toThrow(BadRequestException);
  });

  it('create passes for a valid price and stockStatus', () => {
    insert.mockResolvedValue(makeProduct());

    expect(() =>
      service.create({
        name: 'X',
        priceJod: '10.500',
        stockStatus: 'in_stock',
      }),
    ).not.toThrow();
    expect(insert).toHaveBeenCalled();
  });

  it('create passes when price has no decimals', () => {
    insert.mockResolvedValue(makeProduct());

    expect(() =>
      service.create({ name: 'X', priceJod: '25', stockStatus: 'low' }),
    ).not.toThrow();
  });

  // --- assertWritable via update ---

  it('update throws BadRequestException for an invalid priceJod patch', async () => {
    await expect(
      service.update('p1', { priceJod: 'bad-price' }),
    ).rejects.toThrow(BadRequestException);
    expect(updateById).not.toHaveBeenCalled();
  });

  it('update throws BadRequestException for an invalid stockStatus patch', async () => {
    await expect(
      service.update('p1', { stockStatus: 'bogus' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('update passes for a valid patch', async () => {
    const updated = makeProduct({ priceJod: '20.000' });
    updateById.mockResolvedValue(updated);

    const result = await service.update('p1', { priceJod: '20.000' });

    expect(updateById).toHaveBeenCalledWith('p1', { priceJod: '20.000' });
    expect(result.priceJod).toBe('20.000');
  });

  // --- addImages (upload -> storage -> image_urls) ---

  const file = (name = 'a.jpg') => ({
    buffer: Buffer.from('x'),
    filename: name,
  });

  it('addImages persists KEYS (not URLs) to image_urls and returns resolved URLs', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1' }));
    saveImage
      .mockResolvedValueOnce({
        key: 'k1.jpg',
        url: 'https://pub.example.com/k1.jpg',
      })
      .mockResolvedValueOnce({
        key: 'k2.png',
        url: 'https://pub.example.com/k2.png',
      });
    // Repository persists keys; the returned product still has raw keys.
    const persistedProduct = makeProduct({ imageUrls: ['k1.jpg', 'k2.png'] });
    appendImageUrls.mockResolvedValue(persistedProduct);

    const result = await service.addImages('p1', [
      file('a.jpg'),
      file('b.png'),
    ]);

    expect(saveImage).toHaveBeenCalledTimes(2);
    // KEYS (not URLs) must be written to the database.
    expect(appendImageUrls).toHaveBeenCalledWith('p1', ['k1.jpg', 'k2.png']);
    expect(updateById).not.toHaveBeenCalled();
    // The returned product must have resolved URLs (outward boundary).
    expect(result.imageUrls).toEqual([
      'https://pub.example.com/k1.jpg',
      'https://pub.example.com/k2.png',
    ]);
    expect(getUrl).toHaveBeenCalledWith('k1.jpg');
    expect(getUrl).toHaveBeenCalledWith('k2.png');
  });

  it('addImages with replace=true persists KEYS via updateById and returns resolved URLs', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1' }));
    saveImage.mockResolvedValue({
      key: 'k.jpg',
      url: 'https://pub.example.com/k.jpg',
    });
    const persistedProduct = makeProduct({ imageUrls: ['k.jpg'] });
    updateById.mockResolvedValue(persistedProduct);

    const result = await service.addImages('p1', [file()], { replace: true });

    // KEYS (not URLs) must be written to the database.
    expect(updateById).toHaveBeenCalledWith('p1', { imageUrls: ['k.jpg'] });
    expect(appendImageUrls).not.toHaveBeenCalled();
    // The returned product must have resolved URLs.
    expect(result.imageUrls).toEqual(['https://pub.example.com/k.jpg']);
    expect(getUrl).toHaveBeenCalledWith('k.jpg');
  });

  it('addImages throws BadRequestException when no files are provided', async () => {
    await expect(service.addImages('p1', [])).rejects.toThrow(
      BadRequestException,
    );
    expect(findById).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
  });

  it('addImages throws NotFoundException for a missing product (nothing stored)', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.addImages('ghost', [file()])).rejects.toThrow(
      NotFoundException,
    );
    expect(saveImage).not.toHaveBeenCalled();
  });

  it('addImages cleans up saved files if the product vanishes mid-write', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1' }));
    saveImage.mockResolvedValue({
      key: 'orphan.jpg',
      url: 'https://pub.example.com/orphan.jpg',
    });
    appendImageUrls.mockResolvedValue(undefined); // deleted between check and write

    await expect(service.addImages('p1', [file()])).rejects.toThrow(
      NotFoundException,
    );
    expect(deleteImage).toHaveBeenCalledWith('orphan.jpg');
  });

  // --- getMedia (agent outward boundary) ---

  it('getMedia resolves each key to a URL and returns {url, type} pairs', async () => {
    findById.mockResolvedValue(
      makeProduct({
        id: 'm1',
        isPublished: true,
        imageUrls: ['a.jpg', 'b.png'],
      }),
    );

    const media = await service.getMedia('m1');

    expect(getUrl).toHaveBeenCalledWith('a.jpg');
    expect(getUrl).toHaveBeenCalledWith('b.png');
    expect(media).toEqual([
      { url: 'https://pub.example.com/a.jpg', type: 'image' },
      { url: 'https://pub.example.com/b.png', type: 'image' },
    ]);
  });

  it('getMedia returns [] for a missing or unpublished product', async () => {
    findById.mockResolvedValue(undefined);

    const media = await service.getMedia('ghost');

    expect(media).toEqual([]);
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('getMedia returns [] when imageUrls is empty', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'empty', isPublished: true, imageUrls: [] }),
    );

    const media = await service.getMedia('empty');

    expect(media).toEqual([]);
    expect(getUrl).not.toHaveBeenCalled();
  });

  // --- listImages (admin boundary) ---

  it('listImages resolves keys to URLs and marks index 0 as isPrimary', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png', 'c.webp'] }),
    );

    const images = await service.listImages('p1');

    expect(getUrl).toHaveBeenCalledWith('a.jpg');
    expect(getUrl).toHaveBeenCalledWith('b.png');
    expect(getUrl).toHaveBeenCalledWith('c.webp');
    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({
      key: 'a.jpg',
      url: 'https://pub.example.com/a.jpg',
      isPrimary: true,
    });
    expect(images[1]).toMatchObject({
      key: 'b.png',
      url: 'https://pub.example.com/b.png',
      isPrimary: false,
    });
    expect(images[2]).toMatchObject({
      key: 'c.webp',
      url: 'https://pub.example.com/c.webp',
      isPrimary: false,
    });
  });

  it('listImages returns [] when product has no images', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1', imageUrls: [] }));

    const images = await service.listImages('p1');

    expect(images).toEqual([]);
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('listImages throws NotFoundException for a missing product', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.listImages('ghost')).rejects.toThrow(NotFoundException);
  });

  // --- removeImage ---

  it('removeImage deletes from storage then removes the key from the DB row', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] }),
    );
    const updatedProduct = makeProduct({ id: 'p1', imageUrls: ['b.png'] });
    updateById.mockResolvedValue(updatedProduct);

    const result = await service.removeImage('p1', 'a.jpg');

    // storage.deleteImage must be called BEFORE the DB update.
    const deleteOrder = deleteImage.mock.invocationCallOrder[0];
    const updateOrder = updateById.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(updateOrder);

    expect(deleteImage).toHaveBeenCalledWith('a.jpg');
    expect(updateById).toHaveBeenCalledWith('p1', { imageUrls: ['b.png'] });
    // Result must have keys resolved to URLs (outward boundary).
    expect(result.imageUrls).toEqual(['https://pub.example.com/b.png']);
  });

  it('removeImage throws NotFoundException when the product does not exist', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.removeImage('ghost', 'a.jpg')).rejects.toThrow(
      NotFoundException,
    );
    expect(deleteImage).not.toHaveBeenCalled();
    expect(updateById).not.toHaveBeenCalled();
  });

  it('removeImage throws NotFoundException when the key is not in imageUrls', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg'] }),
    );

    await expect(service.removeImage('p1', 'missing.jpg')).rejects.toThrow(
      NotFoundException,
    );
    expect(deleteImage).not.toHaveBeenCalled();
  });

  // --- setPrimaryImage ---

  it('setPrimaryImage moves the given key to index 0 and persists the order', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png', 'c.webp'] }),
    );
    const reorderedProduct = makeProduct({
      id: 'p1',
      imageUrls: ['b.png', 'a.jpg', 'c.webp'],
    });
    updateById.mockResolvedValue(reorderedProduct);

    const result = await service.setPrimaryImage('p1', 'b.png');

    expect(updateById).toHaveBeenCalledWith('p1', {
      imageUrls: ['b.png', 'a.jpg', 'c.webp'],
    });
    // The returned product has keys resolved to URLs.
    expect(result.imageUrls).toEqual([
      'https://pub.example.com/b.png',
      'https://pub.example.com/a.jpg',
      'https://pub.example.com/c.webp',
    ]);
  });

  it('setPrimaryImage is a no-op when the key is already primary (index 0)', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] }),
    );
    const sameOrder = makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] });
    updateById.mockResolvedValue(sameOrder);

    await service.setPrimaryImage('p1', 'a.jpg');

    // Array order is preserved; no duplication.
    expect(updateById).toHaveBeenCalledWith('p1', {
      imageUrls: ['a.jpg', 'b.png'],
    });
  });

  it('setPrimaryImage throws NotFoundException for a missing product', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.setPrimaryImage('ghost', 'a.jpg')).rejects.toThrow(
      NotFoundException,
    );
    expect(updateById).not.toHaveBeenCalled();
  });

  it('setPrimaryImage throws NotFoundException when key is absent from imageUrls', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg'] }),
    );

    await expect(service.setPrimaryImage('p1', 'missing.jpg')).rejects.toThrow(
      NotFoundException,
    );
    expect(updateById).not.toHaveBeenCalled();
  });

  // --- listImages: colors per image ---

  it('listImages attaches each image its grouped colors (empty when untagged)', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] }),
    );
    findColorsByProduct.mockResolvedValue([
      { storageKey: 'a.jpg', id: 'C-red', name: 'أحمر', family: 'red', hex: '#B0212F' },
      { storageKey: 'a.jpg', id: 'C-black', name: 'أسود', family: 'black', hex: null },
    ]);

    const images = await service.listImages('p1');

    expect(findColorsByProduct).toHaveBeenCalledWith('p1');
    expect(images[0]).toMatchObject({
      key: 'a.jpg',
      isPrimary: true,
      colors: [
        { id: 'C-red', name: 'أحمر', family: 'red', hex: '#B0212F' },
        { id: 'C-black', name: 'أسود', family: 'black', hex: null },
      ],
    });
    // b.png has no tags -> empty colors array.
    expect(images[1]).toMatchObject({
      key: 'b.png',
      isPrimary: false,
      colors: [],
    });
  });

  // --- listImages: per-image embedding status ---

  it('listImages flags hasEmbedding per image from findEmbeddedKeys (published)', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', isPublished: true, imageUrls: ['a.jpg', 'b.png'] }),
    );
    findEmbeddedKeys.mockResolvedValue(['a.jpg']);

    const images = await service.listImages('p1');

    expect(findEmbeddedKeys).toHaveBeenCalledWith('p1', 'test-model');
    expect(images[0]).toMatchObject({ key: 'a.jpg', hasEmbedding: true });
    expect(images[1]).toMatchObject({ key: 'b.png', hasEmbedding: false });
  });

  it('listImages skips the embedding query for a draft (all hasEmbedding false)', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', isPublished: false, imageUrls: ['a.jpg', 'b.png'] }),
    );

    const images = await service.listImages('p1');

    expect(findEmbeddedKeys).not.toHaveBeenCalled();
    expect(images[0]).toMatchObject({ key: 'a.jpg', hasEmbedding: false });
    expect(images[1]).toMatchObject({ key: 'b.png', hasEmbedding: false });
  });

  // --- embeddingSummary ---

  it('embeddingSummary delegates to countEmbeddedByProduct with the current model', async () => {
    countEmbeddedByProduct.mockResolvedValue([
      { productId: 'p1', embeddedCount: 3 },
    ]);

    const summary = await service.embeddingSummary();

    expect(countEmbeddedByProduct).toHaveBeenCalledWith('test-model');
    expect(summary).toEqual([{ productId: 'p1', embeddedCount: 3 }]);
  });

  // --- analyzeImage ---

  it('analyzeImage runs the buffer through embedImage and returns the model id', async () => {
    const buffer = Buffer.from('image-bytes');

    const result = await service.analyzeImage(buffer);

    expect(embedImage).toHaveBeenCalledWith(buffer);
    expect(result).toEqual({ analyzed: true, modelId: 'test-model' });
  });

  it('analyzeImage maps an ImageDecodeError to 422 with code IMAGE_UNREADABLE', async () => {
    embedImage.mockRejectedValueOnce(
      new ImageDecodeError('image could not be decoded'),
    );

    expect.assertions(3);
    try {
      await service.analyzeImage(Buffer.from('corrupt-bytes'));
    } catch (err) {
      // UnprocessableEntityException is the NestJS 422 type; the stable `code`
      // lets the frontend tell a bad image apart from a transient server error.
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const ex = err as UnprocessableEntityException;
      expect(ex.getStatus()).toBe(422);
      expect(ex.getResponse()).toMatchObject({ code: 'IMAGE_UNREADABLE' });
    }
  });

  it('analyzeImage does NOT mask a generic (forward-pass) error — it propagates to 500', async () => {
    embedImage.mockRejectedValueOnce(
      new Error('onnxruntime forward pass failed'),
    );

    const err: unknown = await service
      .analyzeImage(Buffer.from('bad'))
      .catch((e: unknown) => e);

    // A genuine server fault must stay a generic Error (Nest default 500),
    // never be downgraded to a 422.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toBe('onnxruntime forward pass failed');
  });

  // --- findSimilarByImage ---

  const makeEmbeddingRow = (overrides: Record<string, unknown> = {}) => ({
    productId: 'p1',
    name: 'عباءة سوداء',
    priceJod: '49.000',
    colorFamily: 'black',
    occasion: 'سهرة',
    stockStatus: 'in_stock',
    imageKey: 'img-key.jpg',
    imageUrls: ['img-key.jpg'],
    distance: 0.08,
    similarity: 0.92,
    ...overrides,
  });

  it('findSimilarByImage with targetColor resolves color family and forwards it to the repo', async () => {
    resolveColorFamily.mockResolvedValue('red');
    embedImage.mockResolvedValue(new Array(768).fill(0.1));
    searchSimilarByEmbedding.mockResolvedValue([makeEmbeddingRow({ colorFamily: 'red' })]);

    await service.findSimilarByImage('https://x/y.jpg', { targetColor: 'نبيتي' });

    expect(resolveColorFamily).toHaveBeenCalledWith('نبيتي');
    expect(searchSimilarByEmbedding).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      { colorFamily: 'red' },
    );
  });

  it('findSimilarByImage without targetColor calls the repo with no color filter', async () => {
    embedImage.mockResolvedValue(new Array(768).fill(0.1));
    searchSimilarByEmbedding.mockResolvedValue([makeEmbeddingRow()]);

    await service.findSimilarByImage('https://x/y.jpg');

    expect(resolveColorFamily).not.toHaveBeenCalled();
    expect(searchSimilarByEmbedding).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      { colorFamily: undefined },
    );
  });

  it('findSimilarByImage falls back to unfiltered when resolveColorFamily returns null', async () => {
    resolveColorFamily.mockResolvedValue(null);
    embedImage.mockResolvedValue(new Array(768).fill(0.1));
    searchSimilarByEmbedding.mockResolvedValue([makeEmbeddingRow()]);

    await service.findSimilarByImage('https://x/y.jpg', { targetColor: 'مجهول' });

    expect(resolveColorFamily).toHaveBeenCalledWith('مجهول');
    // null resolved → colorFamily is undefined → no color filter
    expect(searchSimilarByEmbedding).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      { colorFamily: undefined },
    );
  });

  // --- setImageColors ---

  it('setImageColors validates colors, replaces the set, returns the descriptor', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] }),
    );
    getManyByIds.mockResolvedValue([
      { id: RED, name: 'أحمر', family: 'red', hex: '#B0212F' },
    ]);

    const result = await service.setImageColors('p1', 'b.png', {
      colorIds: [RED],
    });

    expect(getManyByIds).toHaveBeenCalledWith([RED]);
    expect(replaceForImage).toHaveBeenCalledWith('p1', 'b.png', [RED]);
    expect(result).toEqual({
      key: 'b.png',
      url: 'https://pub.example.com/b.png',
      isPrimary: false,
      colors: [{ id: RED, name: 'أحمر', family: 'red', hex: '#B0212F' }],
    });
  });

  it('setImageColors de-duplicates color ids before validating and writing', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1', imageUrls: ['a.jpg'] }));
    getManyByIds.mockResolvedValue([
      { id: RED, name: 'أحمر', family: 'red', hex: null },
    ]);

    await service.setImageColors('p1', 'a.jpg', {
      colorIds: [RED, RED],
    });

    expect(getManyByIds).toHaveBeenCalledWith([RED]);
    expect(replaceForImage).toHaveBeenCalledWith('p1', 'a.jpg', [RED]);
  });

  it('setImageColors rejects an empty colorIds payload before any DB work', async () => {
    await expect(
      service.setImageColors('p1', 'a.jpg', { colorIds: [] }),
    ).rejects.toThrow(BadRequestException);
    expect(findById).not.toHaveBeenCalled();
    expect(replaceForImage).not.toHaveBeenCalled();
  });

  it('setImageColors throws NotFoundException when the image key is absent', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1', imageUrls: ['a.jpg'] }));

    await expect(
      service.setImageColors('p1', 'missing.jpg', { colorIds: [RED] }),
    ).rejects.toThrow(NotFoundException);
    expect(getManyByIds).not.toHaveBeenCalled();
    expect(replaceForImage).not.toHaveBeenCalled();
  });

  it('setImageColors propagates an unknown color id and never writes', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1', imageUrls: ['a.jpg'] }));
    getManyByIds.mockRejectedValue(
      new NotFoundException(`Unknown color id(s): ${GHOST}`),
    );

    await expect(
      service.setImageColors('p1', 'a.jpg', { colorIds: [GHOST] }),
    ).rejects.toThrow(NotFoundException);
    expect(replaceForImage).not.toHaveBeenCalled();
  });

  it('removeImage clears the image color tags as part of deletion', async () => {
    findById.mockResolvedValue(
      makeProduct({ id: 'p1', imageUrls: ['a.jpg', 'b.png'] }),
    );
    updateById.mockResolvedValue(makeProduct({ id: 'p1', imageUrls: ['b.png'] }));

    await service.removeImage('p1', 'a.jpg');

    expect(deleteForImage).toHaveBeenCalledWith('p1', 'a.jpg');
  });

  // --- resolveForOrder ---

  it('resolveForOrder returns found:true with storageKey = imageUrls[0] for a published in-stock product', async () => {
    const product = makeProduct({
      id: 'ord-1',
      isPublished: true,
      stockStatus: 'in_stock',
      imageUrls: ['primary.jpg', 'secondary.png'],
      sizes: ['S', 'M', 'L'],
      colorFamily: 'blue',
    });
    findById.mockResolvedValue(product);

    const result = await service.resolveForOrder('ord-1');

    expect(result.found).toBe(true);
    if (!result.found) return; // narrow for TS
    expect(result.product.productId).toBe('ord-1');
    expect(result.product.storageKey).toBe('primary.jpg'); // index 0 is the order key
    expect(result.product.name).toBe('عباءة زرقاء');
    expect(result.product.priceJod).toBe('45.000');
    expect(result.product.colorFamily).toBe('blue');
    expect(result.product.available).toBe(true);
    expect(result.product.availableSizes).toEqual(['S', 'M', 'L']);
    // Must NOT have called getUrl — keys only, never URLs
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('resolveForOrder returns available:false and availableSizes:[] when stockStatus is out', async () => {
    const product = makeProduct({
      id: 'ord-2',
      isPublished: true,
      stockStatus: 'out',
      imageUrls: ['img.jpg'],
      sizes: ['M', 'L'],
    });
    findById.mockResolvedValue(product);

    const result = await service.resolveForOrder('ord-2');

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.product.available).toBe(false);
    expect(result.product.availableSizes).toEqual([]);
    // storageKey still present — the product exists and has an image
    expect(result.product.storageKey).toBe('img.jpg');
  });

  it('resolveForOrder returns found:false for a missing product (no throw)', async () => {
    findById.mockResolvedValue(undefined);

    const result = await service.resolveForOrder('missing-uuid');

    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty('product');
  });

  it('resolveForOrder returns found:false for an unpublished product (no throw)', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'draft-1', isPublished: false }));

    const result = await service.resolveForOrder('draft-1');

    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty('product');
  });

  it('resolveForOrder returns found:false when imageUrls is empty (no order key possible)', async () => {
    const product = makeProduct({
      id: 'no-img',
      isPublished: true,
      imageUrls: [],
    });
    findById.mockResolvedValue(product);

    const result = await service.resolveForOrder('no-img');

    expect(result.found).toBe(false);
  });

  it('resolveForOrder returns found:false when imageUrls is null (no order key possible)', async () => {
    const product = makeProduct({
      id: 'null-img',
      isPublished: true,
      imageUrls: null,
    });
    findById.mockResolvedValue(product);

    const result = await service.resolveForOrder('null-img');

    expect(result.found).toBe(false);
  });
});
