/**
 * Unit tests for ProductsAdminController. The service is fully mocked so no
 * database or storage is touched. Guards are NOT applied (NestJS DI context is
 * not bootstrapped) — guard behaviour is covered by dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the products chain doesn't
// try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { ProductsAdminController } from '../products-admin.controller';
import type { ProductsService } from '../products.service';

const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'prod-1',
  name: 'عباءة كحلية',
  priceJod: '55.000',
  colorFamily: 'navy',
  colorShade: null,
  sleeveType: null,
  fabric: null,
  embellishment: null,
  occasion: null,
  sizes: ['S', 'M', 'L'],
  stockStatus: 'in_stock' as const,
  imageUrls: [],
  tags: [],
  attributes: null,
  isPublished: false,
  sku: null,
  description: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ProductsAdminController', () => {
  const create = jest.fn();
  const update = jest.fn();
  const deleteProduct = jest.fn();
  const setPublished = jest.fn();
  const list = jest.fn();

  const service = {
    create,
    update,
    delete: deleteProduct,
    setPublished,
    list,
  } as unknown as ProductsService;

  const controller = new ProductsAdminController(service);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- POST /admin/products ---

  it('create delegates to ProductsService.create with the parsed dto', async () => {
    const dto = { name: 'عباءة', priceJod: '45.000', stockStatus: 'in_stock' as const };
    const product = makeProduct(dto);
    create.mockResolvedValue(product);

    const result = await controller.create(dto);

    expect(create).toHaveBeenCalledWith(dto);
    expect(result).toBe(product);
  });

  it('create propagates service errors (e.g. validation rejection)', async () => {
    create.mockRejectedValue(new NotFoundException('not found'));

    await expect(
      controller.create({ name: 'X', priceJod: '10.000', stockStatus: 'in_stock' }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- PATCH /admin/products/:id ---

  it('update delegates to ProductsService.update with id and patch', async () => {
    const patch = { priceJod: '60.000' };
    const updated = makeProduct({ priceJod: '60.000' });
    update.mockResolvedValue(updated);

    const result = await controller.update('prod-1', patch);

    expect(update).toHaveBeenCalledWith('prod-1', patch);
    expect(result).toBe(updated);
  });

  it('update throws NotFoundException when service does', async () => {
    update.mockRejectedValue(new NotFoundException('Product ghost not found'));

    await expect(controller.update('ghost', { name: 'X' })).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- DELETE /admin/products/:id ---

  it('remove delegates to ProductsService.delete with id', async () => {
    const product = makeProduct({ id: 'prod-1' });
    deleteProduct.mockResolvedValue(product);

    const result = await controller.remove('prod-1');

    expect(deleteProduct).toHaveBeenCalledWith('prod-1');
    expect(result).toBe(product);
  });

  // --- PATCH /admin/products/:id/publish ---

  it('setPublished(id, true) delegates to ProductsService.setPublished with true', async () => {
    const product = makeProduct({ isPublished: true });
    setPublished.mockResolvedValue(product);

    const result = await controller.setPublished('prod-1', { is_published: true });

    expect(setPublished).toHaveBeenCalledWith('prod-1', true);
    expect(result.isPublished).toBe(true);
  });

  it('setPublished(id, false) delegates to ProductsService.setPublished with false', async () => {
    const product = makeProduct({ isPublished: false });
    setPublished.mockResolvedValue(product);

    const result = await controller.setPublished('prod-1', { is_published: false });

    expect(setPublished).toHaveBeenCalledWith('prod-1', false);
    expect(result.isPublished).toBe(false);
  });

  // --- GET /admin/products ---

  it('list with no query params passes empty filter and default options', async () => {
    const page = { items: [], total: 0, limit: 50, offset: 0 };
    list.mockResolvedValue(page);

    const result = await controller.list({
      published: undefined,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      { isPublished: undefined },
      { limit: undefined, offset: undefined },
    );
    expect(result).toBe(page);
  });

  it('list with published=true passes isPublished: true filter', async () => {
    const page = { items: [makeProduct({ isPublished: true })], total: 1, limit: 50, offset: 0 };
    list.mockResolvedValue(page);

    // The ZodValidationPipe transforms the string query param to boolean before
    // the handler is invoked; in the unit test we supply the already-coerced value.
    await controller.list({ published: true, limit: undefined, offset: undefined });

    expect(list).toHaveBeenCalledWith(
      { isPublished: true },
      { limit: undefined, offset: undefined },
    );
  });

  it('list with published=false passes isPublished: false filter', async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    await controller.list({ published: false, limit: undefined, offset: undefined });

    expect(list).toHaveBeenCalledWith(
      { isPublished: false },
      { limit: undefined, offset: undefined },
    );
  });

  it('list passes limit and offset to the service', async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 20 });

    await controller.list({ published: undefined, limit: 10, offset: 20 });

    expect(list).toHaveBeenCalledWith(
      { isPublished: undefined },
      { limit: 10, offset: 20 },
    );
  });
});
