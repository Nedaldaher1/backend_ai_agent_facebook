/**
 * Unit tests for AdProductLinksAdminController. The service is fully mocked so
 * no database is touched. Guards are NOT applied — guard behaviour is covered by
 * dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the products chain doesn't
// try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { AdProductLinksAdminController } from '../ad-product-links-admin.controller';
import type { AdProductLinksService } from '../ad-product-links.service';
import type { AdProductLink } from '../entities/ad-product-link.entity';

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

describe('AdProductLinksAdminController', () => {
  const create = jest.fn();
  const list = jest.fn();
  const update = jest.fn();
  const deleteLink = jest.fn();

  const service = {
    create,
    list,
    update,
    delete: deleteLink,
  } as unknown as AdProductLinksService;

  const controller = new AdProductLinksAdminController(service);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- POST /admin/ad-links ---

  it('create delegates to service.create with the parsed dto', async () => {
    const dto = { adRef: 'summer_2025', productId: PRODUCT_UUID };
    const link = makeLink(dto);
    create.mockResolvedValue(link);

    const result = await controller.create(dto);

    expect(create).toHaveBeenCalledWith(dto);
    expect(result).toBe(link);
  });

  it('create propagates NotFoundException from the service (missing product)', async () => {
    create.mockRejectedValue(new NotFoundException('Product not found'));

    await expect(
      controller.create({ adRef: 'promo', productId: PRODUCT_UUID }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- GET /admin/ad-links ---

  it('list with no query params passes empty filter and default options', async () => {
    const links = [makeLink()];
    list.mockResolvedValue(links);

    const result = await controller.list({
      ad_ref: undefined,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      { adRef: undefined },
      { limit: undefined, offset: undefined },
    );
    expect(result).toBe(links);
  });

  it('list maps ad_ref (snake_case query param) to adRef (camelCase filter)', async () => {
    const links = [makeLink({ adRef: 'summer_2025' })];
    list.mockResolvedValue(links);

    await controller.list({
      ad_ref: 'summer_2025',
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      { adRef: 'summer_2025' },
      { limit: undefined, offset: undefined },
    );
  });

  it('list passes limit and offset to the service', async () => {
    list.mockResolvedValue([]);

    await controller.list({ ad_ref: undefined, limit: 10, offset: 20 });

    expect(list).toHaveBeenCalledWith(
      { adRef: undefined },
      { limit: 10, offset: 20 },
    );
  });

  // --- PATCH /admin/ad-links/:id ---

  it('update delegates to service.update with id and patch', async () => {
    const patch = { position: 3 };
    const updated = makeLink({ position: 3 });
    update.mockResolvedValue(updated);

    const result = await controller.update(LINK_UUID, patch);

    expect(update).toHaveBeenCalledWith(LINK_UUID, patch);
    expect(result).toBe(updated);
  });

  it('update with isActive=false delegates isActive:false to service', async () => {
    const patch = { isActive: false };
    const updated = makeLink({ isActive: false });
    update.mockResolvedValue(updated);

    const result = await controller.update(LINK_UUID, patch);

    expect(update).toHaveBeenCalledWith(LINK_UUID, { isActive: false });
    expect(result.isActive).toBe(false);
  });

  it('update throws NotFoundException when service does', async () => {
    update.mockRejectedValue(new NotFoundException('Ad product link not found'));

    await expect(controller.update('ghost', { position: 1 })).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- DELETE /admin/ad-links/:id ---

  it('remove delegates to service.delete with id and returns deleted link', async () => {
    const link = makeLink();
    deleteLink.mockResolvedValue(link);

    const result = await controller.remove(LINK_UUID);

    expect(deleteLink).toHaveBeenCalledWith(LINK_UUID);
    expect(result).toBe(link);
  });

  it('remove throws NotFoundException when service does', async () => {
    deleteLink.mockRejectedValue(
      new NotFoundException('Ad product link not found'),
    );

    await expect(controller.remove('ghost')).rejects.toThrow(NotFoundException);
  });
});
