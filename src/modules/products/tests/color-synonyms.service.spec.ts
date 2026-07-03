import { NotFoundException } from '@nestjs/common';
import { ColorSynonymsService } from '../color-synonyms.service';
import type { ColorSynonymsRepository } from '../color-synonyms.repository';
import type { ColorsService } from '../colors.service';

// Real uuids — colorId is validated with z.uuid() in createColorSynonymSchema.
const RED = '11111111-1111-4111-8111-111111111111';
const BLUE = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';

const makeSynonym = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs1',
  term: 'نبيتي',
  colorId: RED,
  createdAt: new Date(),
  ...overrides,
});

describe('ColorSynonymsService', () => {
  const list = jest.fn();
  const findById = jest.fn();
  const findByTerm = jest.fn();
  const findByColorId = jest.fn();
  const resolveColorFamilyFn = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const deleteById = jest.fn();

  const repo = {
    list,
    findById,
    findByTerm,
    findByColorId,
    resolveColorFamily: resolveColorFamilyFn,
    insert,
    updateById,
    deleteById,
  } as unknown as ColorSynonymsRepository;

  const getColorById = jest.fn();
  const colorsService = {
    getById: getColorById,
  } as unknown as ColorsService;

  const service = new ColorSynonymsService(repo, colorsService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- resolveColorFamily ---

  it('resolveColorFamily returns the canonical family for a known dialect term', async () => {
    resolveColorFamilyFn.mockResolvedValue('red');

    const result = await service.resolveColorFamily('نبيتي');

    expect(resolveColorFamilyFn).toHaveBeenCalledWith('نبيتي');
    expect(result).toBe('red');
  });

  it('resolveColorFamily returns null for an unknown term', async () => {
    resolveColorFamilyFn.mockResolvedValue(null);

    const result = await service.resolveColorFamily('unknown-term');

    expect(result).toBeNull();
  });

  it('resolveColorFamily returns the mapped family for "كحلي" -> blue', async () => {
    resolveColorFamilyFn.mockResolvedValue('blue');

    const result = await service.resolveColorFamily('كحلي');

    expect(result).toBe('blue');
  });

  // --- getById ---

  it('getById returns the synonym when found', async () => {
    const synonym = makeSynonym({ id: 'cs1' });
    findById.mockResolvedValue(synonym);

    const result = await service.getById('cs1');

    expect(result).toBe(synonym);
  });

  it('getById throws NotFoundException when missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('none')).rejects.toThrow(NotFoundException);
  });

  // --- getByTerm ---

  it('getByTerm returns undefined when the term has no mapping', async () => {
    findByTerm.mockResolvedValue(undefined);

    const result = await service.getByTerm('مجهول');

    expect(result).toBeUndefined();
  });

  it('getByTerm returns the synonym row when found', async () => {
    const synonym = makeSynonym({ term: 'نبيتي' });
    findByTerm.mockResolvedValue(synonym);

    const result = await service.getByTerm('نبيتي');

    expect(result).toBe(synonym);
  });

  // --- create (verifies the color exists before inserting) ---

  it('create verifies the color exists, then inserts the synonym', async () => {
    const synonym = makeSynonym({ term: 'عنابي', colorId: RED });
    getColorById.mockResolvedValue({ id: RED, family: 'red' });
    insert.mockResolvedValue(synonym);

    const result = await service.create({ term: 'عنابي', colorId: RED });

    expect(getColorById).toHaveBeenCalledWith(RED);
    expect(insert).toHaveBeenCalledWith({ term: 'عنابي', colorId: RED });
    expect(result).toBe(synonym);
  });

  it('create throws (and never inserts) when the color does not exist', async () => {
    getColorById.mockRejectedValue(new NotFoundException('Color not found'));

    await expect(
      service.create({ term: 'عنابي', colorId: GHOST }),
    ).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  // --- update ---

  it('update checks the synonym exists, then the replacement color, then persists', async () => {
    const updated = makeSynonym({ id: 'cs1', colorId: BLUE });
    findById.mockResolvedValue(makeSynonym({ id: 'cs1' }));
    getColorById.mockResolvedValue({ id: BLUE, family: 'blue' });
    updateById.mockResolvedValue(updated);

    const result = await service.update('cs1', { colorId: BLUE });

    expect(getColorById).toHaveBeenCalledWith(BLUE);
    expect(updateById).toHaveBeenCalledWith('cs1', { colorId: BLUE });
    expect(result).toBe(updated);
  });

  it('update throws NotFoundException for a missing synonym (no color check)', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.update('ghost', { colorId: BLUE })).rejects.toThrow(
      NotFoundException,
    );
    expect(getColorById).not.toHaveBeenCalled();
    expect(updateById).not.toHaveBeenCalled();
  });

  // --- listByColor ---

  it('listByColor returns every term mapped to a color', async () => {
    const terms = [
      makeSynonym({ term: 'نبيتي' }),
      makeSynonym({ term: 'عنابي' }),
    ];
    findByColorId.mockResolvedValue(terms);

    const result = await service.listByColor('C-red');

    expect(findByColorId).toHaveBeenCalledWith('C-red');
    expect(result).toBe(terms);
  });
});
