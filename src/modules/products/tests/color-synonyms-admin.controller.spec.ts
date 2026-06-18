/**
 * Unit tests for ColorSynonymsAdminController. The service is fully mocked so
 * no database is touched. Guards are NOT applied — guard behaviour is covered by
 * dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the products chain doesn't
// try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { ColorSynonymsAdminController } from '../color-synonyms-admin.controller';
import type { ColorSynonymsService } from '../color-synonyms.service';
import type { ColorSynonym } from '../entities/color-synonym.entity';

const makeSynonym = (overrides: Partial<ColorSynonym> = {}): ColorSynonym => ({
  id: 'cs-1',
  term: 'نبيتي',
  canonicalFamily: 'red',
  createdAt: new Date(),
  ...overrides,
});

describe('ColorSynonymsAdminController', () => {
  const create = jest.fn();
  const list = jest.fn();
  const update = jest.fn();
  const deleteSynonym = jest.fn();

  const service = {
    create,
    list,
    update,
    delete: deleteSynonym,
  } as unknown as ColorSynonymsService;

  const controller = new ColorSynonymsAdminController(service);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- POST /admin/color-synonyms ---

  it('create delegates to service.create with the parsed dto', async () => {
    const dto = { term: 'نبيتي', canonicalFamily: 'red' };
    const synonym = makeSynonym(dto);
    create.mockResolvedValue(synonym);

    const result = await controller.create(dto);

    expect(create).toHaveBeenCalledWith(dto);
    expect(result).toBe(synonym);
  });

  it('create propagates errors from the service', async () => {
    create.mockRejectedValue(new Error('DB unique constraint'));

    await expect(
      controller.create({ term: 'نبيتي', canonicalFamily: 'red' }),
    ).rejects.toThrow('DB unique constraint');
  });

  // --- GET /admin/color-synonyms ---

  it('list with no query params calls service.list with default (empty) options', async () => {
    const synonyms = [makeSynonym()];
    list.mockResolvedValue(synonyms);

    const result = await controller.list({ limit: undefined, offset: undefined });

    expect(list).toHaveBeenCalledWith({ limit: undefined, offset: undefined });
    expect(result).toBe(synonyms);
  });

  it('list passes limit and offset to the service', async () => {
    list.mockResolvedValue([]);

    await controller.list({ limit: 10, offset: 5 });

    expect(list).toHaveBeenCalledWith({ limit: 10, offset: 5 });
  });

  // --- PATCH /admin/color-synonyms/:id ---

  it('update delegates to service.update with id and patch', async () => {
    const patch = { canonicalFamily: 'burgundy' };
    const updated = makeSynonym({ canonicalFamily: 'burgundy' });
    update.mockResolvedValue(updated);

    const result = await controller.update('cs-1', patch);

    expect(update).toHaveBeenCalledWith('cs-1', patch);
    expect(result).toBe(updated);
  });

  it('update throws NotFoundException when service does', async () => {
    update.mockRejectedValue(
      new NotFoundException('Color synonym cs-ghost not found'),
    );

    await expect(
      controller.update('cs-ghost', { canonicalFamily: 'blue' }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- DELETE /admin/color-synonyms/:id ---

  it('remove delegates to service.delete with id and returns the deleted row', async () => {
    const synonym = makeSynonym({ id: 'cs-1' });
    deleteSynonym.mockResolvedValue(synonym);

    const result = await controller.remove('cs-1');

    expect(deleteSynonym).toHaveBeenCalledWith('cs-1');
    expect(result).toBe(synonym);
  });

  it('remove throws NotFoundException when service does', async () => {
    deleteSynonym.mockRejectedValue(
      new NotFoundException('Color synonym not found'),
    );

    await expect(controller.remove('ghost')).rejects.toThrow(NotFoundException);
  });
});
