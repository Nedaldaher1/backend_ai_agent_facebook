import { NotFoundException } from '@nestjs/common';
import { KnowledgeService } from '../knowledge.service';
import type { KnowledgeRepository } from '../knowledge.repository';

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'k1',
  category: 'faq',
  title: 'سياسة الإرجاع',
  content: 'يمكن الإرجاع خلال 7 أيام',
  tags: [],
  priority: 0,
  isPublished: true,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('KnowledgeService', () => {
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
  } as unknown as KnowledgeRepository;

  const service = new KnowledgeService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
    list.mockResolvedValue([]);
    count.mockResolvedValue(0);
  });

  // --- searchPublished forces isPublished: true ---

  it('searchPublished always passes isPublished: true to the repo', async () => {
    await service.searchPublished({ category: 'faq' });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true, category: 'faq' }),
      undefined,
    );
  });

  it('searchPublished with no args still forces isPublished: true', async () => {
    await service.searchPublished();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true }),
      undefined,
    );
  });

  it('searchPublished cannot be overridden by an isPublished input (it is excluded from input type)', async () => {
    // KnowledgeSearchInput omits isPublished, so the type enforces the gate
    await service.searchPublished({ tags: ['return-policy'] });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true }),
      undefined,
    );
  });

  it('searchPublished returns a paginated result shape', async () => {
    const entry = makeEntry();
    list.mockResolvedValue([entry]);
    count.mockResolvedValue(1);

    const result = await service.searchPublished();

    expect(result).toMatchObject({ items: [entry], total: 1 });
  });

  // --- getPublishedById ---

  it('getPublishedById returns the entry when it is published', async () => {
    const entry = makeEntry({ id: 'pub-k1', isPublished: true });
    findById.mockResolvedValue(entry);

    const result = await service.getPublishedById('pub-k1');

    expect(result).toBe(entry);
  });

  it('getPublishedById throws NotFoundException for a draft entry', async () => {
    findById.mockResolvedValue(
      makeEntry({ id: 'draft-k1', isPublished: false }),
    );

    await expect(service.getPublishedById('draft-k1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getPublishedById throws NotFoundException when the entry does not exist', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getPublishedById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- admin path (getById sees drafts) ---

  it('admin getById returns a draft without throwing', async () => {
    const draft = makeEntry({ id: 'draft-k2', isPublished: false });
    findById.mockResolvedValue(draft);

    const result = await service.getById('draft-k2');

    expect(result).toBe(draft);
  });

  it('admin getById throws NotFoundException when missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('none')).rejects.toThrow(NotFoundException);
  });
});
