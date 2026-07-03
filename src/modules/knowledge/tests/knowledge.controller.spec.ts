/**
 * Unit tests for KnowledgeController (admin routes). KnowledgeService is fully
 * mocked — no database is touched. Guards are NOT applied (NestJS DI context is
 * not bootstrapped) — guard behaviour is covered by dedicated guard specs.
 */

// flydrive is ESM-only; stub it so importing the knowledge → products → storage
// chain doesn't try to load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { NotFoundException } from '@nestjs/common';
import { KnowledgeController } from '../knowledge.controller';
import type { KnowledgeService } from '../knowledge.service';

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'k1',
  category: 'faq',
  title: 'سياسة الإرجاع',
  content: 'يمكن الإرجاع خلال 7 أيام',
  tags: [],
  priority: 0,
  isPublished: false,
  createdBy: null,
  productId: null,
  situation: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('KnowledgeController', () => {
  const create = jest.fn();
  const update = jest.fn();
  const deleteEntry = jest.fn();
  const setPublished = jest.fn();
  const list = jest.fn();

  const service = {
    create,
    update,
    delete: deleteEntry,
    setPublished,
    list,
  } as unknown as KnowledgeService;

  const controller = new KnowledgeController(service);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- POST /admin/knowledge ---

  it('create delegates to KnowledgeService.create with the parsed dto', async () => {
    const dto = { category: 'faq' as const, title: 'عنوان', content: 'نص' };
    const entry = makeEntry(dto);
    create.mockResolvedValue(entry);

    const result = await controller.create(dto);

    expect(create).toHaveBeenCalledWith(dto);
    expect(result).toBe(entry);
  });

  it('create with productId passes productId through to the service', async () => {
    const dto = {
      category: 'product_info' as const,
      title: 'عنوان',
      content: 'نص',
      productId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    };
    const entry = makeEntry({ ...dto });
    create.mockResolvedValue(entry);

    const result = await controller.create(dto);

    expect(create).toHaveBeenCalledWith(dto);
    expect(result).toBe(entry);
  });

  it('create propagates NotFoundException when the product does not exist', async () => {
    create.mockRejectedValue(new NotFoundException('Product not found'));

    await expect(
      controller.create({
        category: 'faq',
        title: 'عنوان',
        content: 'نص',
        productId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- PATCH /admin/knowledge/:id ---

  it('update delegates to KnowledgeService.update with id and patch', async () => {
    const patch = { title: 'عنوان محدث' };
    const updated = makeEntry({ title: 'عنوان محدث' });
    update.mockResolvedValue(updated);

    const result = await controller.update('k1', patch);

    expect(update).toHaveBeenCalledWith('k1', patch);
    expect(result).toBe(updated);
  });

  it('update throws NotFoundException when service does', async () => {
    update.mockRejectedValue(
      new NotFoundException('Knowledge entry ghost not found'),
    );

    await expect(controller.update('ghost', { title: 'X' })).rejects.toThrow(
      NotFoundException,
    );
  });

  // --- DELETE /admin/knowledge/:id ---

  it('remove delegates to KnowledgeService.delete with id', async () => {
    const entry = makeEntry({ id: 'k1' });
    deleteEntry.mockResolvedValue(entry);

    const result = await controller.remove('k1');

    expect(deleteEntry).toHaveBeenCalledWith('k1');
    expect(result).toBe(entry);
  });

  it('remove throws NotFoundException when the entry does not exist', async () => {
    deleteEntry.mockRejectedValue(
      new NotFoundException('Knowledge entry ghost not found'),
    );

    await expect(controller.remove('ghost')).rejects.toThrow(NotFoundException);
  });

  // --- PATCH /admin/knowledge/:id/publish ---

  it('setPublished(id, true) maps is_published: true → service.setPublished(id, true)', async () => {
    const entry = makeEntry({ isPublished: true });
    setPublished.mockResolvedValue(entry);

    const result = await controller.setPublished('k1', { is_published: true });

    expect(setPublished).toHaveBeenCalledWith('k1', true);
    expect(result.isPublished).toBe(true);
  });

  it('setPublished(id, false) maps is_published: false → service.setPublished(id, false)', async () => {
    const entry = makeEntry({ isPublished: false });
    setPublished.mockResolvedValue(entry);

    const result = await controller.setPublished('k1', { is_published: false });

    expect(setPublished).toHaveBeenCalledWith('k1', false);
    expect(result.isPublished).toBe(false);
  });

  it('setPublished throws NotFoundException when entry does not exist', async () => {
    setPublished.mockRejectedValue(
      new NotFoundException('Knowledge entry ghost not found'),
    );

    await expect(
      controller.setPublished('ghost', { is_published: true }),
    ).rejects.toThrow(NotFoundException);
  });

  // --- GET /admin/knowledge ---

  it('list with no query params passes empty filter and default options', async () => {
    const page = { items: [], total: 0, limit: 50, offset: 0 };
    list.mockResolvedValue(page);

    const result = await controller.list({
      category: undefined,
      product_id: undefined,
      published: undefined,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      { category: undefined, productId: undefined, isPublished: undefined },
      { limit: undefined, offset: undefined },
    );
    expect(result).toBe(page);
  });

  it('list maps product_id query param to productId filter', async () => {
    const page = { items: [], total: 0, limit: 50, offset: 0 };
    list.mockResolvedValue(page);

    await controller.list({
      category: undefined,
      product_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      published: undefined,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
      expect.anything(),
    );
  });

  it('list maps published=true (already coerced) to isPublished: true filter', async () => {
    const entry = makeEntry({ isPublished: true });
    list.mockResolvedValue({ items: [entry], total: 1, limit: 50, offset: 0 });

    // ZodValidationPipe transforms the string query param to boolean before the
    // handler is invoked; in the unit test we supply the already-coerced value.
    await controller.list({
      category: undefined,
      product_id: undefined,
      published: true,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: true }),
      expect.anything(),
    );
  });

  it('list maps published=false to isPublished: false filter', async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    await controller.list({
      category: undefined,
      product_id: undefined,
      published: false,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ isPublished: false }),
      expect.anything(),
    );
  });

  it('list maps category filter correctly', async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    await controller.list({
      category: 'policy',
      product_id: undefined,
      published: undefined,
      limit: undefined,
      offset: undefined,
    });

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'policy' }),
      expect.anything(),
    );
  });

  it('list passes limit and offset to the service', async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 20 });

    await controller.list({
      category: undefined,
      product_id: undefined,
      published: undefined,
      limit: 10,
      offset: 20,
    });

    expect(list).toHaveBeenCalledWith(expect.anything(), {
      limit: 10,
      offset: 20,
    });
  });
});
