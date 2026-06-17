import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createAgentBehaviorSchema,
  parseOrThrow,
  updateAgentBehaviorSchema,
  type CreateAgentBehaviorInput,
  type UpdateAgentBehaviorInput,
} from '@/common/validation';
import { AgentBehaviorRepository } from './agent-behavior.repository';
import type { AgentBehavior } from './entities/agent-behavior.entity';

/**
 * Agent-persona logic. The agent reads the active behavior to assemble its
 * system prompt; the admin manages the set. Exported for the agent runtime.
 */
@Injectable()
export class AgentBehaviorService {
  private readonly logger = new Logger(AgentBehaviorService.name);

  /**
   * Fallback persona used when no active agent_behavior row exists in the DB
   * or when all persona fields are null/empty.
   */
  private static readonly DEFAULT_PERSONA =
    'أنتِ مساعدة مبيعات لمتجر عبايات "ماسة" في الأردن. ردّي باللهجة الأردنية وباختصار.';

  /**
   * Safety guardrails that are ALWAYS appended to the system prompt regardless
   * of what the admin configures in the agent_behavior table. These are
   * non-negotiable invariants: they ensure the agent never invents prices,
   * never misrepresents order state, and always persists customer profile data
   * to working memory. Admin persona content must never be able to remove them.
   */
  private static readonly GUARDRAILS = [
    'عندما تذكر الزبونة اسمها أو مقاسها أو ألوانها المفضّلة أو ستايلها، احفظيها في الـ working memory مباشرةً باستخدام الأداة المتاحة.',
    'لا تخترعي أسعاراً أو توفراً — استخدمي أدوات البحث والتحقق دائماً للحصول على هذه المعلومات من قاعدة البيانات. إذا لم تتوفر المعلومات، قولي ذلك أو حوّلي إلى موظف.',
    'لا تدّعي أن الطلب اكتمل إذا فشلت أداة تسجيل الطلب أو أعادت خطأ.',
  ].join('\n');

  /** In-memory cache TTL: 60 seconds. */
  private static readonly INSTRUCTIONS_TTL_MS = 60_000;

  /** Cached compiled instructions. Undefined until first call. */
  private instructionsCache: { value: string; expiresAt: number } | undefined;

  constructor(private readonly repo: AgentBehaviorRepository) {}

  /**
   * Compiles the agent's full system prompt from the active agent_behavior row.
   *
   * The result is cached in memory for 60 seconds so that admin edits propagate
   * without a redeploy while avoiding a DB round-trip on every generate() call.
   *
   * Structure: [persona block] + "\n\n" + [guardrails]
   *  - Persona block: built from the active row's persona/tone/rules/greeting fields
   *    (only present fields are included). Falls back to DEFAULT_PERSONA when no
   *    active row exists or all persona fields are null/empty.
   *  - Guardrails: always appended — these are safety invariants the admin cannot remove.
   *
   * On DB error: returns DEFAULT_PERSONA + guardrails and does NOT cache the
   * fallback (a transient error won't lock out admin edits for 60s).
   */
  async getInstructions(): Promise<string> {
    // Serve from cache if still valid.
    if (
      this.instructionsCache &&
      Date.now() < this.instructionsCache.expiresAt
    ) {
      return this.instructionsCache.value;
    }

    let persona: string;
    try {
      const row = await this.getActive();
      persona = this.buildPersonaBlock(row);
    } catch (err) {
      this.logger.warn(
        `Failed to load agent_behavior from DB — using default persona. Error: ${String(err)}`,
      );
      // Do NOT cache the fallback so the next call retries the DB.
      return `${AgentBehaviorService.DEFAULT_PERSONA}\n\n${AgentBehaviorService.GUARDRAILS}`;
    }

    const compiled = `${persona}\n\n${AgentBehaviorService.GUARDRAILS}`;

    this.instructionsCache = {
      value: compiled,
      expiresAt: Date.now() + AgentBehaviorService.INSTRUCTIONS_TTL_MS,
    };

    return compiled;
  }

  /**
   * Builds the persona block from the active agent_behavior row.
   * Returns DEFAULT_PERSONA when no row exists or all relevant fields are empty.
   */
  private buildPersonaBlock(row: AgentBehavior | undefined): string {
    if (!row) {
      return AgentBehaviorService.DEFAULT_PERSONA;
    }

    const lines: string[] = [];

    if (row.persona) lines.push(row.persona);
    if (row.tone) lines.push(`النبرة: ${row.tone}`);
    if (row.rules) lines.push(row.rules);
    if (row.greeting) lines.push(`التحية الافتتاحية: ${row.greeting}`);

    if (lines.length === 0) {
      return AgentBehaviorService.DEFAULT_PERSONA;
    }

    return lines.join('\n');
  }

  list(opts?: ListOptions): Promise<AgentBehavior[]> {
    return this.repo.list(opts);
  }

  /** The behavior the agent should use right now, or undefined if none is set. */
  getActive(): Promise<AgentBehavior | undefined> {
    return this.repo.findActive();
  }

  async getById(id: string): Promise<AgentBehavior> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  create(input: CreateAgentBehaviorInput): Promise<AgentBehavior> {
    const data = parseOrThrow(createAgentBehaviorSchema, input);
    // New personas start inactive; activation is exclusively via setActive,
    // which preserves the single-active-row invariant.
    return this.repo.insert({ ...data, isActive: false });
  }

  async update(
    id: string,
    patch: UpdateAgentBehaviorInput,
  ): Promise<AgentBehavior> {
    const data = parseOrThrow(updateAgentBehaviorSchema, patch);
    const row = await this.repo.updateById(id, data);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  /** Promote one behavior to the single active row (deactivates the rest). */
  async setActive(id: string): Promise<AgentBehavior> {
    const row = await this.repo.setActive(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<AgentBehavior> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Agent behavior ${id} not found`);
    }
    return row;
  }
}
