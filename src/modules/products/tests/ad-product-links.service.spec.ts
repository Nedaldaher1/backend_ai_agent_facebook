// flydrive is ESM-only; stub it so importing the products chain doesn't
// try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { AdProductLinksService } from '../ad-product-links.service';
import type { AdProductLinksRepository } from '../ad-product-links.repository';
import type { ProductsService } from '../products.service';
import type { AdProductLink } from '../entities/ad-product-link.entity';

/** A real v4 UUID used for FK columns that require a valid UUID format. */
const PRODUCT_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LINK_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const makeLink = (overrides: Partial<AdProductLink> = {}): AdProductLink => ({
  id: LINK_UUID,
  adRef: 'summer_2025',
  productId: PRODUCT_UUID,
  position: 0,
  isActive: true,
  campaign: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('AdProductLinksService', () => {
  const repoList = jest.fn();
  const repoFindById = jest.fn();
  const repoInsert = jest.fn();
  const repoUpdateById = jest.fn();
  const repoDeleteById = jest.fn();

  const repo = {
    list: repoList,
    findById: repoFindById,
    insert: repoInsert,
    updateById: repoUpdateById,
    deleteById: repoDeleteById,
  } as unknown as AdProductLinksRepository;

  const productsGetById = jest.fn();
  const productsService = {
    getById: productsGetById,
  } as unknown as ProductsService;

  const service = new AdProductLinksService(repo, productsService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- create ---

  it('create verifies the product exists then inserts the link', async () => {
    const input = { adRef: 'summer_2025', productId: PRODUCT_UUID };
    const link = makeLink(input);
    productsGetById.mockResolvedValue({ id: PRODUCT_UUID });
    repoInsert.mockResolvedValue(link);

    const result = await service.create(input);

    expect(productsGetById).toHaveBeenCalledWith(PRODUCT_UUID);
    expect(repoInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        adRef: 'summer_2025',
        productId: PRODUCT_UUID,
      }),
    );
    expect(result).toBe(link);
  });

  it('create throws NotFoundException (from ProductsService) when the product is missing', async () => {
    productsGetById.mockRejectedValue(
      new NotFoundException(`Product ${PRODUCT_UUID} not found`),
    );

    await expect(
      service.create({ adRef: 'promo', productId: PRODUCT_UUID }),
    ).rejects.toThrow(NotFoundException);

    expect(repoInsert).not.toHaveBeenCalled();
  });

  // --- getById ---

  it('getById returns the link when found', async () => {
    const link = makeLink();
    repoFindById.mockResolvedValue(link);

    const result = await service.getById(LINK_UUID);

    expect(repoFindById).toHaveBeenCalledWith(LINK_UUID);
    expect(result).toBe(link);
  });

  it('getById throws NotFoundException when the row is missing', async () => {
    repoFindById.mockResolvedValue(undefined);

    await expect(service.getById('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- update ---

  it('update without productId skips the product existence check and persists the patch', async () => {
    const patch = { position: 5 };
    const updated = makeLink({ position: 5 });
    repoFindById.mockResolvedValue(makeLink());
    repoUpdateById.mockResolvedValue(updated);

    const result = await service.update(LINK_UUID, patch);

    expect(productsGetById).not.toHaveBeenCalled();
    expect(repoUpdateById).toHaveBeenCalledWith(
      LINK_UUID,
      expect.objectContaining({ position: 5 }),
    );
    expect(result).toBe(updated);
  });

  it('update can toggle isActive to false', async () => {
    const patch = { isActive: false };
    const updated = makeLink({ isActive: false });
    repoFindById.mockResolvedValue(makeLink());
    repoUpdateById.mockResolvedValue(updated);

    const result = await service.update(LINK_UUID, patch);

    expect(repoUpdateById).toHaveBeenCalledWith(
      LINK_UUID,
      expect.objectContaining({ isActive: false }),
    );
    expect(result.isActive).toBe(false);
  });

  it('update with productId verifies the product exists before persisting', async () => {
    const newProductUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const patch = { productId: newProductUuid };
    const updated = makeLink({ productId: newProductUuid });
    repoFindById.mockResolvedValue(makeLink());
    productsGetById.mockResolvedValue({ id: newProductUuid });
    repoUpdateById.mockResolvedValue(updated);

    await service.update(LINK_UUID, patch);

    expect(productsGetById).toHaveBeenCalledWith(newProductUuid);
    expect(repoUpdateById).toHaveBeenCalledWith(
      LINK_UUID,
      expect.objectContaining({ productId: newProductUuid }),
    );
  });

  it('update throws NotFoundException when the product referenced in the patch is missing', async () => {
    repoFindById.mockResolvedValue(makeLink());
    productsGetById.mockRejectedValue(
      new NotFoundException('Product not found'),
    );

    await expect(
      service.update(LINK_UUID, { productId: PRODUCT_UUID }),
    ).rejects.toThrow(NotFoundException);

    expect(repoUpdateById).not.toHaveBeenCalled();
  });

  it('update throws NotFoundException when the link row is missing', async () => {
    repoFindById.mockResolvedValue(undefined);

    await expect(service.update(LINK_UUID, { position: 1 })).rejects.toThrow(
      NotFoundException,
    );

    expect(repoUpdateById).not.toHaveBeenCalled();
  });

  it('update reports the link 404 (not the product) when the link is missing even if productId is given', async () => {
    repoFindById.mockResolvedValue(undefined);

    await expect(
      service.update(LINK_UUID, { productId: PRODUCT_UUID }),
    ).rejects.toThrow(NotFoundException);

    // The link is checked before the referenced product, so the product
    // existence check never runs and no write is attempted.
    expect(productsGetById).not.toHaveBeenCalled();
    expect(repoUpdateById).not.toHaveBeenCalled();
  });

  // --- delete ---

  it('delete returns the deleted row', async () => {
    const link = makeLink();
    repoDeleteById.mockResolvedValue(link);

    const result = await service.delete(LINK_UUID);

    expect(repoDeleteById).toHaveBeenCalledWith(LINK_UUID);
    expect(result).toBe(link);
  });

  it('delete throws NotFoundException when the row is missing', async () => {
    repoDeleteById.mockResolvedValue(undefined);

    await expect(service.delete('ghost-id')).rejects.toThrow(NotFoundException);
  });
});
