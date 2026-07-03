import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from '@mastra/core/agent';
import type { TurnUsage } from '../token-cost.util';

/** The two social-turn kinds the triage tier may answer. */
export type TriageKind = 'greeting' | 'thanks';

/** Outcome of a triage generation (usage present when the model reported it). */
export interface TriageReply {
  reply: string;
  usage?: TurnUsage;
}

/**
 * TriageService — cheap-model tier for pure social turns (TRIAGE_ENABLED).
 *
 * A bare "مرحبا" or "يسلمو" costs a full agent turn today: instructions +
 * 11 tool schemas + history ≈ 4-12k input tokens. These turns need none of
 * that. `match` recognizes them with a STRICT whitelist (full-string match,
 * short-length cap); `reply` answers with a lite model carrying a ~90-token
 * prompt and no tools/history — roughly 1-2% of the full-turn cost.
 *
 * Deliberately NOT matched: bare acks (اه، تمام، اوك، ماشي، طيب) — those are
 * often answers inside an order flow ("تمام" = "yes, confirm it"). AgentService
 * adds its own guards (no image/ad/referral/handoff, greetings only after
 * first touch) before consulting this service.
 *
 * Mirrors VisionService's pattern: lazily-built single-purpose Agent, never
 * throws — every failure falls back to a fixed on-brand line.
 */
@Injectable()
export class TriageService {
  private readonly logger = new Logger(TriageService.name);

  readonly enabled: boolean;
  readonly modelId: string;
  private readonly maxChars: number;

  private agent?: Agent;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('TRIAGE_ENABLED') === 'true';
    this.modelId =
      this.config.get<string>('TRIAGE_MODEL_ID') ??
      'openrouter/google/gemini-3.1-flash-lite';
    this.maxChars = Number(this.config.get<string>('TRIAGE_MAX_CHARS') ?? '40');
  }

  /**
   * Whitelisted pure greetings (full-match after normalization). Kept tight on
   * purpose: a false positive derails a real conversation, a false negative
   * just costs one normal agent turn.
   */
  private static readonly GREETING_RE = new RegExp(
    '^(?:' +
      [
        'ال?سلام(?: عليكم)?(?: ورحمة الله(?: وبركاته)?)?',
        'و?عليكم السلام',
        'مرحبا|مرحبتين|مراحب',
        'هلا(?: والله)?(?: هلا)?',
        '[اأ]هلا(?: وسهلا)?|[اأ]هلين',
        'هاي|هلو',
        'صباح [اأ]?ل?(?:خير|نور)|صباحو',
        'مساء [اأ]?ل?(?:خير|نور)|مساؤكم? [اأ]?ل?(?:خير|نور)|مساكم [اأ]?ل?(?:خير|نور)',
      ].join('|') +
      ')$',
  );

  /** Whitelisted pure thanks (full-match after normalization). */
  private static readonly THANKS_RE = new RegExp(
    '^(?:' +
      [
        'شكرا(?: كتير| جزيلا| [اإ]لك| لك)?',
        'مشكور[ةه]?',
        'يسلمو(?: [اإ]يديك[يم]?)?|تسلم[يو]?(?: [اإ]يديك[يم]?)?',
        '(?:الله )?يعطيك[يم]? العافي[ةه]',
        'ثانكس|thanks|thank you|thx',
      ].join('|') +
      ')$',
    'i',
  );

  /**
   * Classify a customer text as a pure social turn, or null. Normalization:
   * trim, strip common punctuation/tatweel/Arabic diacritics (شكراً → شكرا),
   * collapse whitespace. Anything longer than TRIAGE_MAX_CHARS is never
   * triaged (the full-match whitelist is the real gate; the cap is a bound).
   */
  match(text: string | undefined): TriageKind | null {
    if (!this.enabled) return null;
    const normalized = (text ?? '')
      .replace(/[ً-ٰٟ]/g, '')
      .replace(/[!؟?.,،؛:~ـ*"'()[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized.length === 0 || normalized.length > this.maxChars) {
      return null;
    }
    if (TriageService.GREETING_RE.test(normalized)) return 'greeting';
    if (TriageService.THANKS_RE.test(normalized)) return 'thanks';
    return null;
  }

  /**
   * Generate the one-line reply with the lite model. Never throws: on any
   * failure (or an empty/emoji-only generation) returns the fixed fallback
   * for the kind. Usage is surfaced for the per-turn cost log.
   */
  async reply(kind: TriageKind, text: string): Promise<TriageReply> {
    try {
      const result = (await this.getAgent().generate(
        `(${kind === 'greeting' ? 'تحية' : 'شكر'}) ${text}`,
        { modelSettings: { temperature: 0.6, maxOutputTokens: 80 } },
      )) as {
        text?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          cachedInputTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
        };
      };
      const reply = (result.text ?? '').trim();
      const usage: TurnUsage | undefined = result.usage
        ? {
            inputTokens: result.usage.inputTokens ?? result.usage.promptTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            outputTokens:
              result.usage.outputTokens ?? result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined;
      if (!reply) {
        return {
          reply: TriageService.fallback(kind),
          ...(usage ? { usage } : {}),
        };
      }
      return { reply, ...(usage ? { usage } : {}) };
    } catch (err) {
      this.logger.warn(
        `triage model call failed — using fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { reply: TriageService.fallback(kind) };
    }
  }

  /** Fixed on-brand lines used when the lite model fails. No emoji. */
  private static fallback(kind: TriageKind): string {
    return kind === 'greeting'
      ? 'أهلين فيكي، كيف بقدر أساعدك؟'
      : 'ولو، تكرمي. أي إشي ثاني بتحتاجيه أنا موجودة.';
  }

  /** Lazily build the lite reply agent (mirrors VisionService.getAgent). */
  private getAgent(): Agent {
    if (!this.agent) {
      this.agent = new Agent({
        id: 'triage-social',
        name: 'Masa Triage Social Reply',
        instructions:
          'You are "لمى", the friendly sales assistant of Masa (ماسة), a Jordanian women\'s clothing store, chatting on Messenger. ' +
          'The customer sent a pure greeting or thanks (labelled in parentheses). Reply with ONE short warm line in Jordanian colloquial Arabic (العامية الأردنية). ' +
          'Rules: no emojis; no فصحى or Egyptian/Gulf dialect; for a greeting, welcome her back and offer help (e.g. "أهلين فيكي، كيف بقدر أساعدك؟"); ' +
          'for thanks, respond graciously (e.g. "ولو، تكرمي"). Never mention products, prices, or offers.',
        model: this.modelId,
      });
    }
    return this.agent;
  }
}
