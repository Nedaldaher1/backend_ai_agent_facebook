import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@/core/tenancy/tenant-context';
import { ColorsService } from '../colors.service';
import type { ColorsRepository } from '../colors.repository';
import type { ProductImageColorsRepository } from '../product-image-colors.repository';

const makeColor = (overrides: Record<string, unknown> = {}) => ({
  id: 'C-red',
  name: 'أحمر',
  family: 'red',
  hex: '#B0212F',
  isActive: true,
  isSystem: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** The seeded "__unassigned__" sentinel — a system color. */
const SENTINEL = makeColor({
  id: 'C-unassigned',
  name: 'غير معرف',
  family: '__unassigned__',
  hex: null,
  isActive: false,
  isSystem: true,
});

describe('ColorsService', () => {
  const list = jest.fn();
  const findById = jest.fn();
  const findByFamily = jest.fn();
  const findManyByIds = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const deleteById = jest.fn();
  const deleteWithReassignment = jest.fn();

  const repo = {
    list,
    findById,
    findByFamily,
    findManyByIds,
    insert,
    updateById,
    deleteById,
    deleteWithReassignment,
  } as unknown as ColorsRepository;

  const colorUsage = jest.fn();
  const imageColors = {
    colorUsage,
  } as unknown as ProductImageColorsRepository;

  // Single-tenant stub: these tests don't exercise cross-tenant isolation of
  // the sentinel-id cache, just that it still resolves/caches correctly.
  const tenantContext = { tenantId: 'tenant-a' } as unknown as TenantContext;

  let service: ColorsService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fresh instance each test so the cached sentinel id never leaks across tests.
    service = new ColorsService(repo, imageColors, tenantContext);
  });

  // --- getById ---

  it('getById returns the color when found', async () => {
    const color = makeColor();
    findById.mockResolvedValue(color);

    expect(await service.getById('C-red')).toBe(color);
  });

  it('getById throws NotFoundException when missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('ghost')).rejects.toThrow(NotFoundException);
  });

  // --- getManyByIds ---

  it('getManyByIds returns the rows when every id exists (de-duping input)', async () => {
    const rows = [makeColor({ id: 'C-red' }), makeColor({ id: 'C-black' })];
    findManyByIds.mockResolvedValue(rows);

    const result = await service.getManyByIds(['C-red', 'C-black', 'C-red']);

    expect(findManyByIds).toHaveBeenCalledWith(['C-red', 'C-black']);
    expect(result).toBe(rows);
  });

  it('getManyByIds throws NotFoundException naming the missing id(s)', async () => {
    findManyByIds.mockResolvedValue([makeColor({ id: 'C-red' })]);

    await expect(service.getManyByIds(['C-red', 'C-ghost'])).rejects.toThrow(
      /C-ghost/,
    );
  });

  // --- create ---

  it('create inserts a valid color', async () => {
    const color = makeColor();
    insert.mockResolvedValue(color);

    const result = await service.create({
      name: 'أحمر',
      family: 'red',
      hex: '#B0212F',
    });

    expect(insert).toHaveBeenCalledWith({
      name: 'أحمر',
      family: 'red',
      hex: '#B0212F',
    });
    expect(result).toBe(color);
  });

  it('create throws BadRequestException when a required field is missing', () => {
    expect(() => service.create({ name: 'أحمر' } as never)).toThrow(
      BadRequestException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('create rejects an attempt to set is_system (stripped/strict)', () => {
    // is_system is omitted from the create schema, so .strict() rejects it.
    expect(() =>
      service.create({ name: 'أحمر', family: 'red', isSystem: true } as never),
    ).toThrow(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('create maps a duplicate-family unique violation to 409 Conflict', async () => {
    // colors_family_idx is unique; a second color with family "red" collides.
    insert.mockRejectedValue({ code: '23505' });

    await expect(
      service.create({ name: 'أحمر', family: 'red', hex: '#d62929' }),
    ).rejects.toThrow(ConflictException);
  });

  it('create rethrows a non-unique database error unchanged', async () => {
    const err = new Error('connection lost');
    insert.mockRejectedValue(err);

    await expect(service.create({ name: 'أحمر', family: 'red' })).rejects.toBe(
      err,
    );
  });

  // --- update ---

  it('update persists a valid patch (name/hex/isActive)', async () => {
    findById.mockResolvedValue(makeColor());
    const updated = makeColor({ name: 'أحمر داكن' });
    updateById.mockResolvedValue(updated);

    const result = await service.update('C-red', { name: 'أحمر داكن' });

    expect(updateById).toHaveBeenCalledWith('C-red', { name: 'أحمر داكن' });
    expect(result).toBe(updated);
  });

  it('update throws NotFoundException when the color is missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.update('ghost', { name: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    expect(updateById).not.toHaveBeenCalled();
  });

  it('update rejects editing a system color (400)', async () => {
    findById.mockResolvedValue(SENTINEL);

    await expect(service.update('C-unassigned', { name: 'x' })).rejects.toThrow(
      BadRequestException,
    );
    expect(updateById).not.toHaveBeenCalled();
  });

  it('update rejects a family change without confirmation (409)', async () => {
    findById.mockResolvedValue(makeColor({ family: 'red' }));

    await expect(service.update('C-red', { family: 'maroon' })).rejects.toThrow(
      ConflictException,
    );
    expect(updateById).not.toHaveBeenCalled();
  });

  it('update allows a family change when confirmFamilyChange is true', async () => {
    findById.mockResolvedValue(makeColor({ family: 'red' }));
    const updated = makeColor({ family: 'maroon' });
    updateById.mockResolvedValue(updated);

    const result = await service.update('C-red', { family: 'maroon' }, true);

    expect(updateById).toHaveBeenCalledWith('C-red', { family: 'maroon' });
    expect(result).toBe(updated);
  });

  it('update maps a duplicate-family unique violation to 409 Conflict', async () => {
    // Even with confirmFamilyChange, the new family must clear the unique index.
    findById.mockResolvedValue(makeColor({ family: 'red' }));
    updateById.mockRejectedValue({ code: '23505' });

    await expect(
      service.update('C-red', { family: 'maroon' }, true),
    ).rejects.toThrow(ConflictException);
  });

  it('update allows a no-op family (same value) without confirmation', async () => {
    findById.mockResolvedValue(makeColor({ family: 'red' }));
    updateById.mockResolvedValue(makeColor());

    await service.update('C-red', { family: 'red' });

    expect(updateById).toHaveBeenCalledWith('C-red', { family: 'red' });
  });

  // --- delete (safe delete with reassignment) ---

  it('delete reassigns image tags to the sentinel and returns the counts', async () => {
    findById.mockResolvedValue(makeColor({ id: 'C-red' }));
    findByFamily.mockResolvedValue(SENTINEL);
    deleteWithReassignment.mockResolvedValue({
      reassignedImages: 3,
      affectedProducts: 2,
    });

    const result = await service.delete('C-red');

    expect(findByFamily).toHaveBeenCalledWith('__unassigned__');
    expect(deleteWithReassignment).toHaveBeenCalledWith(
      'C-red',
      'C-unassigned',
    );
    expect(result).toEqual({
      deleted: true,
      reassignedImages: 3,
      affectedProducts: 2,
    });
  });

  it('delete rejects deleting a system color (400) before touching anything', async () => {
    findById.mockResolvedValue(SENTINEL);

    await expect(service.delete('C-unassigned')).rejects.toThrow(
      BadRequestException,
    );
    expect(findByFamily).not.toHaveBeenCalled();
    expect(deleteWithReassignment).not.toHaveBeenCalled();
  });

  it('delete throws NotFoundException when the color is missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.delete('ghost')).rejects.toThrow(NotFoundException);
    expect(deleteWithReassignment).not.toHaveBeenCalled();
  });

  it('delete throws NotFoundException if the row vanished mid-transaction', async () => {
    findById.mockResolvedValue(makeColor());
    findByFamily.mockResolvedValue(SENTINEL);
    deleteWithReassignment.mockResolvedValue(undefined);

    await expect(service.delete('C-red')).rejects.toThrow(NotFoundException);
  });

  it('delete maps a concurrent FK violation to 409 Conflict', async () => {
    findById.mockResolvedValue(makeColor());
    findByFamily.mockResolvedValue(SENTINEL);
    deleteWithReassignment.mockRejectedValue({ code: '23503' });

    await expect(service.delete('C-red')).rejects.toThrow(ConflictException);
  });

  it('delete rethrows a non-FK database error unchanged', async () => {
    findById.mockResolvedValue(makeColor());
    findByFamily.mockResolvedValue(SENTINEL);
    const err = new Error('connection lost');
    deleteWithReassignment.mockRejectedValue(err);

    await expect(service.delete('C-red')).rejects.toBe(err);
  });

  it('delete throws 500 when the sentinel color is not seeded', async () => {
    findById.mockResolvedValue(makeColor());
    findByFamily.mockResolvedValue(undefined);

    await expect(service.delete('C-red')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(deleteWithReassignment).not.toHaveBeenCalled();
  });

  // --- usage ---

  it('usage returns the report with hasMore=false within the cap', async () => {
    findById.mockResolvedValue(makeColor());
    colorUsage.mockResolvedValue({
      productCount: 2,
      imageCount: 5,
      products: [
        { id: 'p1', name: 'A' },
        { id: 'p2', name: 'B' },
      ],
    });

    const result = await service.usage('C-red');

    expect(colorUsage).toHaveBeenCalledWith('C-red', 50);
    expect(result).toEqual({
      productCount: 2,
      imageCount: 5,
      products: [
        { id: 'p1', name: 'A' },
        { id: 'p2', name: 'B' },
      ],
      hasMore: false,
    });
  });

  it('usage sets hasMore=true when more products use the color than are listed', async () => {
    findById.mockResolvedValue(makeColor());
    colorUsage.mockResolvedValue({
      productCount: 51,
      imageCount: 99,
      products: new Array(50).fill(null).map((_, i) => ({
        id: `p${i}`,
        name: `name-${i}`,
      })),
    });

    const result = await service.usage('C-red');

    expect(result.hasMore).toBe(true);
  });

  it('usage 404s when the color is missing (without querying usage)', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.usage('ghost')).rejects.toThrow(NotFoundException);
    expect(colorUsage).not.toHaveBeenCalled();
  });

  // --- unassignedUsage ---

  it('unassignedUsage reports the sentinel usage (review queue)', async () => {
    findByFamily.mockResolvedValue(SENTINEL);
    findById.mockResolvedValue(SENTINEL);
    colorUsage.mockResolvedValue({
      productCount: 1,
      imageCount: 1,
      products: [{ id: 'p1', name: 'A' }],
    });

    const result = await service.unassignedUsage();

    expect(findByFamily).toHaveBeenCalledWith('__unassigned__');
    expect(colorUsage).toHaveBeenCalledWith('C-unassigned', 50);
    expect(result.productCount).toBe(1);
  });
});
