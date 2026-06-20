/**
 * Unit tests for ColorsAdminController. Both services are fully mocked so no
 * database is touched. Guards are NOT applied — guard behaviour is covered by
 * dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the products chain doesn't try to
// load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ColorsAdminController } from '../colors-admin.controller';
import type { ColorsService } from '../colors.service';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { Color } from '../entities/color.entity';

const makeColor = (overrides: Partial<Color> = {}): Color => ({
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

describe('ColorsAdminController', () => {
  const create = jest.fn();
  const list = jest.fn();
  const getById = jest.fn();
  const update = jest.fn();
  const deleteColor = jest.fn();
  const usage = jest.fn();
  const unassignedUsage = jest.fn();
  const colors = {
    create,
    list,
    getById,
    update,
    delete: deleteColor,
    usage,
    unassignedUsage,
  } as unknown as ColorsService;

  const listByColor = jest.fn();
  const synonyms = {
    listByColor,
  } as unknown as ColorSynonymsService;

  const controller = new ColorsAdminController(colors, synonyms);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create delegates to colors.create', async () => {
    const dto = { name: 'أحمر', family: 'red', hex: '#B0212F' };
    const color = makeColor();
    create.mockResolvedValue(color);

    expect(await controller.create(dto)).toBe(color);
    expect(create).toHaveBeenCalledWith(dto);
  });

  it('list passes pagination through to colors.list', async () => {
    list.mockResolvedValue([makeColor()]);

    await controller.list({ limit: 10, offset: 5 });

    expect(list).toHaveBeenCalledWith({ limit: 10, offset: 5 });
  });

  it('getOne composes the color with its dialect terms', async () => {
    const color = makeColor({ id: 'C-red' });
    const terms = [
      { id: 'cs1', term: 'نبيتي', colorId: 'C-red', createdAt: new Date() },
      { id: 'cs2', term: 'عنابي', colorId: 'C-red', createdAt: new Date() },
    ];
    getById.mockResolvedValue(color);
    listByColor.mockResolvedValue(terms);

    const result = await controller.getOne('C-red');

    expect(getById).toHaveBeenCalledWith('C-red');
    expect(listByColor).toHaveBeenCalledWith('C-red');
    expect(result).toEqual({ ...color, synonyms: terms });
  });

  it('getOne propagates NotFoundException from colors.getById', async () => {
    getById.mockRejectedValue(new NotFoundException('Color ghost not found'));

    await expect(controller.getOne('ghost')).rejects.toThrow(NotFoundException);
    expect(listByColor).not.toHaveBeenCalled();
  });

  it('usage delegates to colors.usage', async () => {
    const report = {
      productCount: 2,
      imageCount: 5,
      products: [{ id: 'p1', name: 'A' }],
      hasMore: false,
    };
    usage.mockResolvedValue(report);

    expect(await controller.usage('C-red')).toBe(report);
    expect(usage).toHaveBeenCalledWith('C-red');
  });

  it('unassignedUsage delegates to colors.unassignedUsage', async () => {
    const report = {
      productCount: 0,
      imageCount: 0,
      products: [],
      hasMore: false,
    };
    unassignedUsage.mockResolvedValue(report);

    expect(await controller.unassignedUsage()).toBe(report);
    expect(unassignedUsage).toHaveBeenCalledTimes(1);
  });

  it('update defaults confirmFamilyChange to false', async () => {
    update.mockResolvedValue(makeColor({ name: 'أحمر داكن' }));

    await controller.update('C-red', { name: 'أحمر داكن' });

    expect(update).toHaveBeenCalledWith('C-red', { name: 'أحمر داكن' }, false);
  });

  it('update forwards confirmFamilyChange=true only for the literal "true"', async () => {
    update.mockResolvedValue(makeColor({ family: 'maroon' }));

    await controller.update('C-red', { family: 'maroon' }, 'true');
    expect(update).toHaveBeenCalledWith('C-red', { family: 'maroon' }, true);

    update.mockClear();
    await controller.update('C-red', { family: 'maroon' }, 'false');
    expect(update).toHaveBeenCalledWith('C-red', { family: 'maroon' }, false);
  });

  it('update propagates a 409 when a family change is unconfirmed', async () => {
    update.mockRejectedValue(
      new ConflictException('Re-send with ?confirmFamilyChange=true'),
    );

    await expect(
      controller.update('C-red', { family: 'maroon' }),
    ).rejects.toThrow(ConflictException);
  });

  it('remove returns the reassignment result from colors.delete', async () => {
    const result = {
      deleted: true as const,
      reassignedImages: 3,
      affectedProducts: 2,
    };
    deleteColor.mockResolvedValue(result);

    expect(await controller.remove('C-red')).toBe(result);
    expect(deleteColor).toHaveBeenCalledWith('C-red');
  });

  it('remove propagates a 400 when the color is a system color', async () => {
    deleteColor.mockRejectedValue(
      new BadRequestException('system color and cannot be deleted'),
    );

    await expect(controller.remove('C-unassigned')).rejects.toThrow(
      BadRequestException,
    );
  });
});
