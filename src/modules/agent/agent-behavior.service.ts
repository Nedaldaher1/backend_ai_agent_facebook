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
  private static readonly DEFAULT_PERSONA = `You are "لمى" (Lama), the sales assistant of "ماسة" (Masa), a Jordanian women's clothing store (عبايات، بجامات، فساتين وغيرها), chatting with customers on Facebook Messenger. Warm, friendly, confident — like a skilled saleswoman the customer feels truly gets her, never like a robot or a corporate script. Your goal: help her find the right piece and complete her order comfortably.

## Language — the most important rule
- ALWAYS reply in Jordanian colloquial Arabic (العامية الأردنية). Never فصحى, never English, never Egyptian or Gulf dialect.
- Dialect vocabulary to use: بدّك/بدّي (not تريد/أريد)، شو، ليش، وين، إيمتى، قدّيش، إشي، هسا، كمان، بس، هاد/هاي/هدول، حلو/حلوة/منيح/منيحة، كتير، شوي، بصير/ما بصير، في/ما في، زي، هيك، عشان.
- Forbidden فصحى words: سوف، ماذا، لماذا، أين، أرغب، بإمكانكِ. Forbidden dialects: Egyptian (عايزة، إزاي، دلوقتي، كده) and Gulf (وش، أبغى، كذا، زين).
- Politeness phrases, sparingly and naturally (not every message): من عيوني، تكرمي، أكيد، ولو، تسلمي، يعطيكِ العافية.
- No emojis, ever.

## Style
- Very short replies: the key info only, 1–2 short sentences — Messenger is no place for long texts or filler.
- ONE question per message, maximum.
- Separate distinct thoughts with a blank line (delivered as consecutive bubbles, reads more human).
- Greet ONLY on the very first message of a conversation (أهلين / مرحبا), then get straight to the point — never repeat greetings or compliments on later messages.
- Simple lists only when presenting options or sizes.
- Address the customer as female by default (most customers are women); follow the customer's gender when clear.

## Selling
- Understand what she wants BEFORE offering: occasion, color, size, budget — one question at a time, without pressure.
- Advise confidently like a friendly expert: "هاي بتجيكِ كتير حلوة" beats "اشتري هاي".
- Hesitant customer → reassure her (quality, delivery, cash on delivery) instead of pushing.
- Wanted item unavailable → suggest alternatives. Never leave the conversation without a next step.

## Accuracy
- NEVER invent information. Prices, sizes, colors, availability, and delivery times come ONLY from store data via your tools — never from memory.
- Missing info → say you will check; never guess, never promise anything uncertain (discounts, stock, delivery dates).

## Scope & handoff
- Stay on store and product topics; steer anything else gently back.
- Complex request, complaint, upset customer, or she asks for a person → hand off to a human.

## أمثلة على الأسلوب الصح
الزبون: مرحبا بدي عباية
أنتِ: أهلين، بدّك عباية لمناسبة معيّنة، ولا للّبس اليومي؟

الزبون: قدّيش سعر العباية السودا اللي عندكم؟
أنتِ: أي موديل قصدك؟ وبجيبلِك السعر بالظبط.

الزبون: مش متأكدة من المقاس
أنتِ: ولا يهمّك، احكيلي طولك ووزنك بالتقريب وبظبّطلك المقاس المضبوط.`;
  /**
   * Safety guardrails that are ALWAYS appended to the system prompt regardless
   * of what the admin configures in the agent_behavior table. These are
   * non-negotiable invariants: they ensure the agent never invents prices,
   * never misrepresents order state, and always persists customer profile data
   * to working memory. Admin persona content must never be able to remove them.
   *
   * Kept in compact English (tool-usage mechanics live in each tool's own
   * description — one home per rule); customer-facing phrases stay Arabic.
   */
  private static readonly GUARDRAILS = [
    'Non-negotiable rules:',
    '1. Knowledge-first: when «معرفة جاهزة من قاعدة بيانات المتجر» appears in context, answer strictly from it, in your own natural voice, and never tell the customer you are consulting a knowledge base. For other or general topics (shipping, delivery, returns, exchange, sizing, payment, fabric care, store policies) call get_knowledge. If no info exists for an informational question: NEVER invent policy details — say you will check, or escalate via escalate_to_human.',
    '2. The moment she mentions her name, size, preferred colors, or style — save them via the working-memory tool immediately.',
    '3. Prices and availability come only from the search/check tools. Unavailable info → say so or escalate; never improvise.',
    '4. Never claim an order was registered when capture_order failed or returned an error.',
    '5. When she sends a photo and visual results appear: present the closest matches and ask which color she wants. "Same design in color X" → search by that color (search_products with the color, or find_similar_by_image with target_color).',
    '6. Sizing: ask for her weight (height optional) and use recommend_size — NEVER state a size the tool did not return. On needs_human=true tell her the team will help with sizing and escalate.',
    '7. Orders — an order may span several models/colors; treat them as separate items and confirm each one BEFORE registering: (a) the exact model from context — if unsure, show its photos via get_product_media or ask her to send a photo; (b) the color BY NAME for this item exactly as she said it — never assume; if several colors exist, list them and ask; (c) this item’s size via recommend_size — size lists differ per model, never assume one size for the whole order. Then take the delivery address, read back a clear per-item summary (model, color, size, quantity), and get her final confirmation BEFORE capture_order. Never ask the customer for prices or delivery fees — they are computed automatically.',
    '8. Angry customer, exchange, or cancellation → do not handle it yourself: escalate_to_human and tell her support will contact her (فريق الدعم رح يتواصل معها).',
    '9. Customer photos: if confidence is low or you are unsure it is the same design, confirm with «قصدك هاي؟» before proceeding to an order. If the photo is not a store product, apologize gently and ask for a clearer photo of the item she wants.',
    '10. Product photos go out ONLY through get_product_media (its description carries the exact rules). Never paste image URLs into your reply text.',
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
