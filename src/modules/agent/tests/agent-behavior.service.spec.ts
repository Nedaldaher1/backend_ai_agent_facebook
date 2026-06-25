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

  // --- getInstructions ---
  // Each test creates a fresh AgentBehaviorService instance so the in-memory
  // cache does not leak between tests (jest.clearAllMocks() resets mock call
  // counts but cannot clear the instance-level cache property).

  describe('getInstructions', () => {
    it('composes prompt from active row persona and appends guardrails', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior({ persona: 'أنا مساعد متجر ماسة' })),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const result = await svc.getInstructions();

      expect(result).toContain('أنا مساعد متجر ماسة');
      expect(result).toContain('لا تخترعي أسعاراً');
    });

    it('falls back to DEFAULT_PERSONA when no active row exists', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(undefined),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const result = await svc.getInstructions();

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('ماسة');
      expect(result).toContain('لا تخترعي أسعاراً');
    });

    it('guardrails are present even when active row has persona content', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(
          makeBehavior({
            persona: 'مساعدة ودودة',
            tone: 'warm',
            rules: 'تجنبي الحديث عن المنافسين',
            greeting: 'أهلاً حبيبتي',
          }),
        ),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const result = await svc.getInstructions();

      // All three guardrail substrings must appear.
      expect(result).toContain('احفظيها في الـ working memory');
      expect(result).toContain('لا تخترعي أسعاراً');
      expect(result).toContain('لا تدّعي أن الطلب اكتمل');
      // Knowledge-first directive: consult get_knowledge before answering/acting.
      expect(result).toContain('المعرفة أولاً');
      expect(result).toContain('get_knowledge');
    });

    it('caches the result and calls findActive only once on two calls', async () => {
      const localFindActive = jest.fn().mockResolvedValue(makeBehavior());
      const freshRepo = {
        list,
        findActive: localFindActive,
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const first = await svc.getInstructions();
      const second = await svc.getInstructions();

      expect(localFindActive).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('never throws when findActive rejects — returns default brand text instead', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockRejectedValue(new Error('DB down')),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const result = await svc.getInstructions();

      expect(result).toContain('ماسة');
    });

    // --- conversational-judgment guardrails (AIA-41) ---

    it('contains visual-search color guidance referencing target_color', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior()),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const out = await svc.getInstructions();

      expect(out).toContain('target_color');
    });

    it('contains size-recommendation guidance referencing recommend_size and needs_human', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior()),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const out = await svc.getInstructions();

      expect(out).toContain('recommend_size');
      expect(out).toContain('لا تذكري أبداً مقاساً');
    });

    it('contains order-capture guidance referencing get_product_for_order and capture_order', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior()),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const out = await svc.getInstructions();

      expect(out).toContain('get_product_for_order');
      expect(out).toContain('capture_order');
    });

    it('order-capture guidance confirms color + size per item and reads back a summary', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior()),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const out = await svc.getInstructions();

      // A multi-model/multi-color order is treated as separate items, each confirmed.
      expect(out).toContain('كأصناف منفصلة');
      // The agent reads back an itemized summary before capturing the order.
      expect(out).toContain('ملخص');
      // Each item's colour is passed BY NAME to capture_order — the selector that
      // pins the right variant image (fixes all-items-take-the-primary-colour).
      expect(out).toContain('(color)');
      // And the agent must never guess a colour.
      expect(out).toContain('لا تخمّني لوناً');
    });

    it('contains escalation guidance referencing escalate_to_human', async () => {
      const freshRepo = {
        list,
        findActive: jest.fn().mockResolvedValue(makeBehavior()),
        findById,
        insert,
        updateById,
        setActive,
        deleteById,
      } as unknown as AgentBehaviorRepository;
      const svc = new AgentBehaviorService(freshRepo);

      const out = await svc.getInstructions();

      expect(out).toContain('escalate_to_human');
    });
  });
});
