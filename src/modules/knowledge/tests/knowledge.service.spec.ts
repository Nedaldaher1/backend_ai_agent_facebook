// flydrive is ESM-only; stub it so importing the knowledge → products → storage
// chain doesn't try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { KnowledgeService } from '../knowledge.service';
import type { KnowledgeRepository } from '../knowledge.repository';
import type { ProductsService } from '@/modules/products/products.service';

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

const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'عباءة',
  priceJod: '45.000',
  stockStatus: 'in_stock' as const,
  isPublished: true,
  colorFamily: null,
  colorShade: null,
  sleeveType: null,
  fabric: null,
  embellishment: null,
  occasion: null,
  sizes: [],
  imageUrls: [],
  tags: [],
  attributes: null,
  sku: null,
  description: null,
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

  const getById = jest.fn();
  const products = { getById } as unknown as ProductsService;

  const service = new KnowledgeService(repo, products);

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
      findRelevant.mockImplementation((filter: { scope: { type: string } }) => {
        if (filter.scope.type === 'global') return Promise.resolve([g1, g2]);
        return Promise.resolve([]);
      });

      const result = await service.getRelevant({ query: 'توصيل' });

      // Called exactly once — for the global scope (no productIds means specific tier is skipped)
      expect(findRelevant).toHaveBeenCalledTimes(1);
      expect(findRelevant).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { type: 'global' },
          isPublished: true,
        }),
      );
      expect(result).toEqual([g1, g2]);
    });

    it('product-specific-only: returns product rows; global NOT called when 5 product rows fill the limit', async () => {
      const ps = Array.from({ length: 5 }, (_, i) =>
        makeEntry({ id: `ps${i}`, productId: 'p1' }),
      );

      findRelevant.mockImplementation((filter: { scope: { type: string } }) => {
        if (filter.scope.type === 'products') return Promise.resolve(ps);
        return Promise.resolve([]);
      });

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

      findRelevant.mockImplementation((filter: { scope: { type: string } }) => {
        if (filter.scope.type === 'products')
          return Promise.resolve([ps1, ps2]);
        return Promise.resolve([]);
      });

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

      findRelevant.mockImplementation((filter: { scope: { type: string } }) => {
        if (filter.scope.type === 'products') return Promise.resolve([ps1]);
        return Promise.resolve([g1, g2]);
      });

      const result = await service.getRelevant({
        productIds: ['p1'],
        query: 'q',
      });

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

      findRelevant.mockImplementation((filter: { scope: { type: string } }) => {
        if (filter.scope.type === 'products') return Promise.resolve(ps);
        return Promise.resolve([]);
      });

      const result = await service.getRelevant({ productIds: ['p1'] });

      expect(result).toHaveLength(5);
      // remaining === 0 → global-scope call never made
      const globalCall = (
        findRelevant.mock.calls as Array<[{ scope: { type: string } }]>
      ).find(([f]) => f.scope.type === 'global');
      expect(globalCall).toBeUndefined();
    });
  });

  // --- create: product existence check ---

  /** A fixed valid UUID used as a product id in tests. */
  const PRODUCT_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  describe('create', () => {
    it('create with a valid productId verifies the product then inserts', async () => {
      const product = makeProduct({ id: PRODUCT_UUID });
      getById.mockResolvedValue(product);
      const entry = makeEntry({ productId: PRODUCT_UUID });
      insert.mockResolvedValue(entry);

      const result = await service.create({
        category: 'faq',
        title: 'عنوان',
        content: 'محتوى',
        productId: PRODUCT_UUID,
      });

      expect(getById).toHaveBeenCalledWith(PRODUCT_UUID);
      expect(insert).toHaveBeenCalled();
      expect(result).toBe(entry);
    });

    it('create with a missing product throws NotFoundException and does NOT insert', async () => {
      getById.mockRejectedValue(new NotFoundException('Product not found'));

      await expect(
        service.create({
          category: 'faq',
          title: 'عنوان',
          content: 'محتوى',
          productId: PRODUCT_UUID,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(insert).not.toHaveBeenCalled();
    });

    it('create with null productId (global entry) does NOT call products.getById and inserts', async () => {
      const entry = makeEntry({ productId: null });
      insert.mockResolvedValue(entry);

      const result = await service.create({
        category: 'policy',
        title: 'سياسة',
        content: 'نص السياسة',
        productId: null,
      });

      expect(getById).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalled();
      expect(result).toBe(entry);
    });

    it('create without productId (global entry) does NOT call products.getById and inserts', async () => {
      const entry = makeEntry({ productId: null });
      insert.mockResolvedValue(entry);

      const result = await service.create({
        category: 'shipping',
        title: 'توصيل',
        content: 'نص التوصيل',
      });

      expect(getById).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalled();
      expect(result).toBe(entry);
    });
  });

  // --- update: product existence check ---

  const PRODUCT_UUID_2 = 'b1cccd00-1d1c-4ff9-ab7e-7cc0ce491b22';

  describe('update', () => {
    it('update with a valid productId verifies the product then patches', async () => {
      const product = makeProduct({ id: PRODUCT_UUID_2 });
      getById.mockResolvedValue(product);
      const entry = makeEntry({ id: 'k1', productId: PRODUCT_UUID_2 });
      updateById.mockResolvedValue(entry);

      const result = await service.update('k1', { productId: PRODUCT_UUID_2 });

      expect(getById).toHaveBeenCalledWith(PRODUCT_UUID_2);
      expect(updateById).toHaveBeenCalledWith('k1', {
        productId: PRODUCT_UUID_2,
      });
      expect(result).toBe(entry);
    });

    it('update with a missing product throws NotFoundException and does NOT update', async () => {
      getById.mockRejectedValue(new NotFoundException('Product not found'));

      await expect(
        service.update('k1', { productId: PRODUCT_UUID }),
      ).rejects.toThrow(NotFoundException);

      expect(updateById).not.toHaveBeenCalled();
    });

    it('update with productId: null (make global) does NOT call products.getById', async () => {
      const entry = makeEntry({ id: 'k1', productId: null });
      updateById.mockResolvedValue(entry);

      const result = await service.update('k1', { productId: null });

      expect(getById).not.toHaveBeenCalled();
      expect(updateById).toHaveBeenCalledWith('k1', { productId: null });
      expect(result).toBe(entry);
    });

    it('update without productId field does NOT call products.getById', async () => {
      const entry = makeEntry({ id: 'k1', title: 'تحديث' });
      updateById.mockResolvedValue(entry);

      const result = await service.update('k1', { title: 'تحديث' });

      expect(getById).not.toHaveBeenCalled();
      expect(updateById).toHaveBeenCalledWith('k1', { title: 'تحديث' });
      expect(result).toBe(entry);
    });
  });

  // --- list: productId filter is passed through ---

  describe('list', () => {
    it('list passes productId filter to the repo', async () => {
      const entry = makeEntry({ productId: 'p1' });
      list.mockResolvedValue([entry]);
      count.mockResolvedValue(1);

      await service.list({ productId: 'p1' });

      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p1' }),
        undefined,
      );
    });

    it('list without productId does not include productId in the filter', async () => {
      await service.list({ category: 'faq' });

      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'faq' }),
        undefined,
      );
      // productId should not be present (or be undefined)
      const callArg = (list.mock.calls[0] as [Record<string, unknown>])[0];
      expect(callArg.productId).toBeUndefined();
    });
  });
});
