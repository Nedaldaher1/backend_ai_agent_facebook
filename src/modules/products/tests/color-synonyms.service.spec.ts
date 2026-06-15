import { NotFoundException } from '@nestjs/common';
import { ColorSynonymsService } from '../color-synonyms.service';
import type { ColorSynonymsRepository } from '../color-synonyms.repository';

const makeSynonym = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs1',
  term: 'نبيتي',
  canonicalFamily: 'red',
  createdAt: new Date(),
  ...overrides,
});

describe('ColorSynonymsService', () => {
  const list = jest.fn();
  const findById = jest.fn();
  const findByTerm = jest.fn();
  const resolveColorFamilyFn = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const deleteById = jest.fn();

  const repo = {
    list,
    findById,
    findByTerm,
    resolveColorFamily: resolveColorFamilyFn,
    insert,
    updateById,
    deleteById,
  } as unknown as ColorSynonymsRepository;

  const service = new ColorSynonymsService(repo);

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
});
