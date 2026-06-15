import { NotFoundException } from '@nestjs/common';
import { AgentBehaviorService } from '../agent-behavior.service';
import type { AgentBehaviorRepository } from '../agent-behavior.repository';

const makeBehavior = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  persona: 'أنا مساعد متجر ماسة للعبايات',
  tone: 'friendly',
  rules: null,
  greeting: 'أهلاً وسهلاً',
  fallbackMessage: null,
  escalationTriggers: null,
  isActive: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('AgentBehaviorService', () => {
  const list = jest.fn();
  const findActive = jest.fn();
  const findById = jest.fn();
  const insert = jest.fn();
  const updateById = jest.fn();
  const setActive = jest.fn();
  const deleteById = jest.fn();

  const repo = {
    list,
    findActive,
    findById,
    insert,
    updateById,
    setActive,
    deleteById,
  } as unknown as AgentBehaviorRepository;

  const service = new AgentBehaviorService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- create always forces isActive: false ---

  it('create forces isActive: false even when caller passes isActive: true', async () => {
    const stored = makeBehavior({ isActive: false });
    insert.mockResolvedValue(stored);

    await service.create({ persona: 'test', isActive: true });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  it('create forces isActive: false when caller passes isActive: false (unchanged)', async () => {
    const stored = makeBehavior({ isActive: false });
    insert.mockResolvedValue(stored);

    await service.create({ persona: 'test', isActive: false });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  it('create passes other fields through to the repo unchanged', async () => {
    const stored = makeBehavior();
    insert.mockResolvedValue(stored);

    await service.create({
      persona: 'مساعد ودود',
      tone: 'warm',
      greeting: 'أهلاً',
      isActive: true,
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: 'مساعد ودود',
        tone: 'warm',
        greeting: 'أهلاً',
        isActive: false,
      }),
    );
  });

  // --- getById ---

  it('getById returns the behavior when found', async () => {
    const behavior = makeBehavior({ id: 'b2' });
    findById.mockResolvedValue(behavior);

    const result = await service.getById('b2');

    expect(result).toBe(behavior);
  });

  it('getById throws NotFoundException when missing', async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById('ghost')).rejects.toThrow(NotFoundException);
  });

  // --- setActive ---

  it('setActive throws NotFoundException when the id does not exist', async () => {
    setActive.mockResolvedValue(undefined);

    await expect(service.setActive('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('setActive returns the activated behavior on success', async () => {
    const activated = makeBehavior({ id: 'b3', isActive: true });
    setActive.mockResolvedValue(activated);

    const result = await service.setActive('b3');

    expect(result.isActive).toBe(true);
  });
});
