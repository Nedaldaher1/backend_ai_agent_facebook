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
  productId: null,
  situation: null,
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
  const findRelevant = jest.fn();

  const repo = {
    list,
    count,
    findById,
    insert,
    updateById,
    deleteById,
    setPublished,
    findRelevant,
  } as unknown as KnowledgeRepository;

  const service = new KnowledgeService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
    list.mockResolvedValue([]);
    count.mockResolvedValue(0);
    findRelevant.mockResolvedValue([]);
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

  // --- getRelevant ---

  describe('getRelevant', () => {
    it('global-only: calls findRelevant once with scope.type=global and isPublished:true when no productIds given', async () => {
      const g1 = makeEntry({ id: 'g1', productId: null });
      const g2 = makeEntry({ id: 'g2', productId: null });

      // findRelevant returns global rows when called with global scope
      findRelevant.mockImplementation(
        (filter: { scope: { type: string } }) => {
          if (filter.scope.type === 'global') return Promise.resolve([g1, g2]);
          return Promise.resolve([]);
        },
      );

      const result = await service.getRelevant({ query: 'توصيل' });

      // Called exactly once — for the global scope (no productIds means specific tier is skipped)
      expect(findRelevant).toHaveBeenCalledTimes(1);
      expect(findRelevant).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { type: 'global' }, isPublished: true }),
      );
      expect(result).toEqual([g1, g2]);
    });

    it('product-specific-only: returns product rows; global NOT called when 5 product rows fill the limit', async () => {
      const ps = Array.from({ length: 5 }, (_, i) =>
        makeEntry({ id: `ps${i}`, productId: 'p1' }),
      );

      findRelevant.mockImplementation(
        (filter: { scope: { type: string } }) => {
          if (filter.scope.type === 'products') return Promise.resolve(ps);
          return Promise.resolve([]);
        },
      );

      const result = await service.getRelevant({ productIds: ['p1'] });

      // Products scope was called with the right productIds + publish gate
      expect(findRelevant).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { type: 'products', productIds: ['p1'] },
          isPublished: true,
        }),
      );
      // 5 product rows fill the cap → global scope NOT called (remaining=0)
      expect(findRelevant).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(5);
    });

    it('product-specific-only (under limit): sets productIds on the products-scope call', async () => {
      const ps1 = makeEntry({ id: 'ps1', productId: 'p1' });
      const ps2 = makeEntry({ id: 'ps2', productId: 'p1' });

      findRelevant.mockImplementation(
        (filter: { scope: { type: string } }) => {
          if (filter.scope.type === 'products') return Promise.resolve([ps1, ps2]);
          return Promise.resolve([]);
        },
      );

      const result = await service.getRelevant({ productIds: ['p1'] });

      expect(findRelevant).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { type: 'products', productIds: ['p1'] },
          isPublished: true,
        }),
      );
      expect(result).toEqual([ps1, ps2]);
    });

    it('both-merged: product-specific rows appear FIRST, then global; deduped', async () => {
      const ps1 = makeEntry({ id: 'ps1', productId: 'p1' });
      const g1 = makeEntry({ id: 'g1', productId: null });
      const g2 = makeEntry({ id: 'g2', productId: null });

      findRelevant.mockImplementation(
        (filter: { scope: { type: string } }) => {
          if (filter.scope.type === 'products') return Promise.resolve([ps1]);
          return Promise.resolve([g1, g2]);
        },
      );

      const result = await service.getRelevant({ productIds: ['p1'], query: 'q' });

      // Product-specific entry is first
      expect(result[0].id).toBe('ps1');
      expect(result[1].id).toBe('g1');
      expect(result[2].id).toBe('g2');
      expect(result).toHaveLength(3);
    });

    it('cap: result never exceeds 5 entries', async () => {
      const ps = Array.from({ length: 5 }, (_, i) =>
        makeEntry({ id: `ps${i}`, productId: 'p1' }),
      );

      findRelevant.mockImplementation(
        (filter: { scope: { type: string } }) => {
          if (filter.scope.type === 'products') return Promise.resolve(ps);
          return Promise.resolve([]);
        },
      );

      const result = await service.getRelevant({ productIds: ['p1'] });

      expect(result).toHaveLength(5);
      // remaining === 0 → global-scope call never made
      const globalCall = (findRelevant.mock.calls as Array<[{ scope: { type: string } }]>).find(
        ([f]) => f.scope.type === 'global',
      );
      expect(globalCall).toBeUndefined();
    });
  });
});
