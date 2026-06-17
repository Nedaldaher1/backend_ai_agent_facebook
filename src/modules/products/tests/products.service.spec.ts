// flydrive is ESM-only and isolated inside StorageService; stub it so importing
// the products -> storage chain doesn't load the real module under Jest (CJS).
// This spec injects a mock StorageService, so the stubs are never exercised.
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ProductsService } from '../products.service';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { ProductsRepository } from '../products.repository';
import type { StorageService } from '@/core/storage/storage.service';

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
  const storage = {
    saveImage,
    deleteImage,
  } as unknown as StorageService;

  const service = new ProductsService(repo, colors, storage);

  beforeEach(() => {
    jest.clearAllMocks();
    list.mockResolvedValue([]);
    count.mockResolvedValue(0);
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

  it('getPublishedById returns the product when it is published', async () => {
    const product = makeProduct({ id: 'pub-1', isPublished: true });
    findById.mockResolvedValue(product);

    const result = await service.getPublishedById('pub-1');

    expect(result).toBe(product);
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

  it('addImages appends saved URLs to image_urls by default', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1' }));
    saveImage
      .mockResolvedValueOnce({ key: 'k1.jpg', url: 'http://h/uploads/k1.jpg' })
      .mockResolvedValueOnce({ key: 'k2.png', url: 'http://h/uploads/k2.png' });
    const updated = makeProduct({
      imageUrls: ['http://h/uploads/k1.jpg', 'http://h/uploads/k2.png'],
    });
    appendImageUrls.mockResolvedValue(updated);

    const result = await service.addImages('p1', [
      file('a.jpg'),
      file('b.png'),
    ]);

    expect(saveImage).toHaveBeenCalledTimes(2);
    expect(appendImageUrls).toHaveBeenCalledWith('p1', [
      'http://h/uploads/k1.jpg',
      'http://h/uploads/k2.png',
    ]);
    expect(updateById).not.toHaveBeenCalled();
    expect(result).toBe(updated);
  });

  it('addImages replaces image_urls when replace=true', async () => {
    findById.mockResolvedValue(makeProduct({ id: 'p1' }));
    saveImage.mockResolvedValue({
      key: 'k.jpg',
      url: 'http://h/uploads/k.jpg',
    });
    const updated = makeProduct({ imageUrls: ['http://h/uploads/k.jpg'] });
    updateById.mockResolvedValue(updated);

    const result = await service.addImages('p1', [file()], { replace: true });

    expect(updateById).toHaveBeenCalledWith('p1', {
      imageUrls: ['http://h/uploads/k.jpg'],
    });
    expect(appendImageUrls).not.toHaveBeenCalled();
    expect(result).toBe(updated);
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
      url: 'http://h/uploads/orphan.jpg',
    });
    appendImageUrls.mockResolvedValue(undefined); // deleted between check and write

    await expect(service.addImages('p1', [file()])).rejects.toThrow(
      NotFoundException,
    );
    expect(deleteImage).toHaveBeenCalledWith('orphan.jpg');
  });
});
