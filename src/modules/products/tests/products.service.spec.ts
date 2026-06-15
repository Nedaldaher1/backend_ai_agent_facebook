import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ProductsService } from '../products.service';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { ProductsRepository } from '../products.repository';

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

  const repo = {
    list,
    count,
    findById,
    insert,
    updateById,
    deleteById,
    setPublished,
  } as unknown as ProductsRepository;

  const colors = {
    resolveColorFamily,
  } as unknown as ColorSynonymsService;

  const service = new ProductsService(repo, colors);

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
});
