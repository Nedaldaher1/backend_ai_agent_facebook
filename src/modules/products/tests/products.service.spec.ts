import { ProductsService } from '../products.service';
import type { ProductsRepository } from '../products.repository';

describe('ProductsService', () => {
  const resolveColorFamily = jest.fn();
  const findPublished = jest.fn();
  const findById = jest.fn();

  const repo = {
    resolveColorFamily,
    findPublished,
    findById,
  } as unknown as ProductsRepository;

  const service = new ProductsService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
    findPublished.mockResolvedValue([]);
  });

  it('normalizes a dialect color term to its family before searching', async () => {
    resolveColorFamily.mockResolvedValue('red');

    await service.search({ color: 'نبيتي' });

    expect(resolveColorFamily).toHaveBeenCalledWith('نبيتي');
    expect(findPublished).toHaveBeenCalledWith(
      expect.objectContaining({ colorFamily: 'red' }),
    );
  });

  it('passes an explicit colorFamily through without a synonym lookup', async () => {
    await service.search({ colorFamily: 'blue' });

    expect(resolveColorFamily).not.toHaveBeenCalled();
    expect(findPublished).toHaveBeenCalledWith(
      expect.objectContaining({ colorFamily: 'blue' }),
    );
  });

  it('throws when an unpublished product is requested by id', async () => {
    findById.mockResolvedValue({ id: 'x', isPublished: false });

    await expect(service.getPublishedById('x')).rejects.toThrow('not found');
  });
});
