/**
 * TranscriptionService — turns a customer voice note (Messenger audio
 * attachment) into dialect-aware Arabic text using a dedicated audio-input
 * model (Gemini 3.5 Flash via OpenRouter by default), so the sales agent can
 * understand spoken requests — especially colloquial/broken Arabic.
 *
 * Design (mirrors VisionService):
 *  - Runs as a deterministic PRE-GENERATE step (called from AgentService when an
 *    audio attachment is present), NOT as an agent tool — audio presence is known
 *    up front and the workflow models it as a fixed branch.
 *  - A SEPARATE single-purpose model owns audio (TRANSCRIPTION_MODEL_ID); the
 *    sales agent only ever sees the resulting text.
 *  - NEVER throws: every failure path returns { ok: false, reason } so the
 *    customer's turn always proceeds to the deterministic degrade flow.
 *  - Audio bytes are downloaded once and inlined as base64: Mastra's bundled
 *    OpenRouter provider maps a user-content `file` part with an audio media
 *    type to OpenRouter `input_audio`, and rejects http(s) URLs outright.
 *
 * The live model call cannot be exercised in dev (the OPENROUTER_API_KEY is a
 * placeholder → 401); correctness here is covered by unit tests with a mocked
 * agent, and the transport shape is verified against the bundled provider
 * source. Validate end-to-end once a real key is configured (see plan).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from '@mastra/core/agent';
import { formatCostMeta, type TurnUsage } from '../token-cost.util';
import {
  AudioTooLargeError,
  AudioUnsupportedError,
  downloadAudio,
} from './audio-download.util';
import {
  transcriptionOutputSchema,
  type TranscriptionOutput,
} from './transcription.schema';

/** Why a voice note yielded no usable transcript (for the degrade flow + telemetry). */
export type TranscriptionDegradeReason =
  | 'disabled'
  | 'fetch_failed'
  | 'unsupported_format'
  | 'too_large'
  | 'too_long'
  | 'model_failed'
  | 'unintelligible'
  | 'low_confidence';

/**
 * Outcome of a transcription attempt.
 *  - `ok` is true only when the transcript is non-empty, the model judged the
 *    audio intelligible, and confidence cleared the configured minimum.
 *  - On `ok: false`, `reason` drives the deterministic retry/escalation flow;
 *    `transcript` may still carry the low-confidence text for the admin log.
 */
export interface TranscriptionResult {
  ok: boolean;
  transcript: string | null;
  normalizedText?: string;
  language?: string;
  confidence: number | null;
  reason?: TranscriptionDegradeReason;
  meta: {
    model: string;
    latencyMs: number;
    audioBytes?: number;
    durationSec?: number;
    usage?: TurnUsage;
  };
}

const TRANSCRIPTION_SYSTEM_PROMPT =
  'أنتِ ناسخة رسائل صوتية لمتجر عبايات نسائية في الأردن. الزبونات يتكلمن غالباً ' +
  'باللهجة الأردنية أو الشامية، وأحياناً بلهجات عربية أخرى أو عربية مكسّرة، عن ' +
  'العبايات والمقاسات والألوان والأسعار والتوصيل. فرّغي الصوت حرفياً بالحرف العربي ' +
  'كما نُطق (حافظي على العامية ولا تفصّحيها)، واكتبي الأرقام — مقاسات وأسعار ' +
  'وأرقام هواتف — أرقاماً. ضعي في normalizedText صياغة مبسطة مفهومة فقط إذا كان ' +
  'الكلام مكسّراً أو مختلطاً بحيث قد يُساء فهم النص الحرفي، وإلا اتركيه null. ' +
  'حدّدي اللغة/اللهجة في language، وقيّمي وضوح التسجيل بصدق في confidence. إذا كان ' +
  'الصوت غير مفهوم أو فارغاً أو ليس كلاماً فاضبطي intelligible=false — لا تخمّني ' +
  'محتوى لم تسمعيه أبداً.';

const TRANSCRIPTION_USER_PROMPT =
  'فرّغي هذا التسجيل الصوتي وفق المخطط المطلوب.';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  private readonly enabled: boolean;
  private readonly modelId: string;
  private readonly minConfidence: number;
  private readonly maxBytes: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxDurationSec: number;

  private agent?: Agent;

  constructor(private readonly config: ConfigService) {
    // Opt-in (mirrors TRIAGE_ENABLED): only the literal 'true' enables. The
    // webhook controller gates on the same flag, so this is defense-in-depth.
    this.enabled = this.config.get<string>('TRANSCRIPTION_ENABLED') === 'true';
    this.modelId =
      this.config.get<string>('TRANSCRIPTION_MODEL_ID') ??
      'openrouter/google/gemini-3.5-flash';
    this.minConfidence = Number(
      this.config.get<string>('TRANSCRIPTION_MIN_CONFIDENCE') ?? '0.45',
    );
    this.maxBytes = Number(
      this.config.get<string>('AUDIO_MAX_BYTES') ?? '10000000',
    );
    this.fetchTimeoutMs = Number(
      this.config.get<string>('AUDIO_FETCH_TIMEOUT_MS') ?? '10000',
    );
    this.maxDurationSec = Number(
      this.config.get<string>('AUDIO_MAX_DURATION_SEC') ?? '180',
    );
  }

  /**
   * Transcribe a customer voice-note URL. NEVER throws — every failure path
   * returns { ok: false, reason } so the turn proceeds to the degrade flow.
   */
  async transcribe(input: { url: string }): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    const fail = (
      reason: TranscriptionDegradeReason,
      extra?: Partial<Pick<TranscriptionResult, 'transcript' | 'confidence'>> &
        Partial<TranscriptionResult['meta']>,
    ): TranscriptionResult => {
      const { transcript = null, confidence = null, ...meta } = extra ?? {};
      const result: TranscriptionResult = {
        ok: false,
        transcript,
        confidence,
        reason,
        meta: {
          model: this.modelId,
          latencyMs: Date.now() - startedAt,
          ...meta,
        },
      };
      this.logResult(result);
      return result;
    };

    if (!this.enabled) {
      return fail('disabled');
    }

    // 1. Fetch the audio (temporary URL → bytes → base64 for the model).
    let audio: Awaited<ReturnType<typeof downloadAudio>>;
    try {
      audio = await downloadAudio(input.url, {
        maxBytes: this.maxBytes,
        timeoutMs: this.fetchTimeoutMs,
      });
    } catch (err) {
      const reason: TranscriptionDegradeReason =
        err instanceof AudioTooLargeError
          ? 'too_large'
          : err instanceof AudioUnsupportedError
            ? 'unsupported_format'
            : 'fetch_failed';
      this.logger.warn(
        `transcription: audio fetch failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(reason);
    }

    // 2. Duration cap (best-effort mvhd sniff; the byte cap is the hard guard).
    if (
      audio.durationSec !== undefined &&
      audio.durationSec > this.maxDurationSec
    ) {
      return fail('too_long', {
        audioBytes: audio.buffer.length,
        durationSec: audio.durationSec,
      });
    }

    // 3. Ask the transcription model for structured output.
    let parsed: TranscriptionOutput;
    let usage: TurnUsage | undefined;
    try {
      const dataUrl = `data:${audio.mediaType};base64,${audio.buffer.toString('base64')}`;
      const result = await this.getAgent().generate(
        [
          {
            role: 'user',
            content: [
              // A `file` part (NOT a URL): the bundled OpenRouter provider maps
              // audio/* file parts to input_audio and rejects http(s) URLs.
              { type: 'file', data: dataUrl, mediaType: audio.mediaType },
              { type: 'text', text: TRANSCRIPTION_USER_PROMPT },
            ],
          },
        ],
        {
          structuredOutput: { schema: transcriptionOutputSchema },
          modelSettings: { temperature: 0.1, maxOutputTokens: 1024 },
        },
      );
      usage = this.normalizeUsage(result);
      // Mastra populates `.object` for structured output; fall back to parsing
      // the text so a provider returning JSON text still works.
      const raw =
        (result as { object?: unknown }).object ??
        this.safeJson((result as { text?: string }).text);
      const validated = transcriptionOutputSchema.safeParse(raw);
      if (!validated.success) {
        this.logger.warn(
          'transcription: model output failed schema validation',
        );
        return fail('model_failed', {
          audioBytes: audio.buffer.length,
          durationSec: audio.durationSec,
          usage,
        });
      }
      parsed = validated.data;
    } catch (err) {
      this.logger.warn(
        `transcription: model call failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail('model_failed', {
        audioBytes: audio.buffer.length,
        durationSec: audio.durationSec,
      });
    }

    // 4. Judge usability: non-empty + intelligible + confidence over the floor.
    const transcript = parsed.transcript.trim() || null;
    const reason: TranscriptionDegradeReason | undefined =
      !transcript || !parsed.intelligible
        ? 'unintelligible'
        : parsed.confidence < this.minConfidence
          ? 'low_confidence'
          : undefined;

    const result: TranscriptionResult = {
      ok: reason === undefined,
      transcript,
      ...(parsed.normalizedText
        ? { normalizedText: parsed.normalizedText }
        : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
      confidence: parsed.confidence,
      ...(reason ? { reason } : {}),
      meta: {
        model: this.modelId,
        latencyMs: Date.now() - startedAt,
        audioBytes: audio.buffer.length,
        ...(audio.durationSec !== undefined
          ? { durationSec: audio.durationSec }
          : {}),
        ...(usage ? { usage } : {}),
      },
    };
    this.logResult(result);
    return result;
  }

  /** Lazily build the transcription agent (boots that never see audio pay nothing). */
  private getAgent(): Agent {
    if (!this.agent) {
      this.agent = new Agent({
        id: 'voice-transcriber',
        name: 'Masa Voice Transcriber',
        instructions: TRANSCRIPTION_SYSTEM_PROMPT,
        model: this.modelId,
      });
    }
    return this.agent;
  }

  /**
   * One line per attempt: the only per-call transcription signal in the logs.
   * Note: formatCostMeta prices ALL input tokens at the text rate — Gemini
   * bills audio input tokens higher (~2x), so voice estimates are understated.
   */
  private logResult(r: TranscriptionResult): void {
    this.logger.log(
      `transcription: ok=${r.ok}${r.reason ? ` reason=${r.reason}` : ''}` +
        `${r.language ? ` lang=${r.language}` : ''} conf=${r.confidence ?? '?'}` +
        `${r.meta.audioBytes !== undefined ? ` bytes=${r.meta.audioBytes}` : ''}` +
        `${r.meta.durationSec !== undefined ? ` durationSec=${Math.round(r.meta.durationSec)}` : ''}` +
        ` latencyMs=${r.meta.latencyMs}${formatCostMeta(this.modelId, r.meta.usage)}`,
    );
  }

  /** Normalize the provider usage block (AI SDK v5 or legacy field names). */
  private normalizeUsage(result: unknown): TurnUsage | undefined {
    const u = (
      result as {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          cachedInputTokens?: number;
        };
      }
    ).usage;
    if (!u) return undefined;
    const inputTokens = u.inputTokens ?? u.promptTokens;
    const outputTokens = u.outputTokens ?? u.completionTokens;
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      u.totalTokens === undefined
    ) {
      return undefined;
    }
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(u.cachedInputTokens !== undefined
        ? { cachedInputTokens: u.cachedInputTokens }
        : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(u.totalTokens !== undefined ? { totalTokens: u.totalTokens } : {}),
    };
  }

  private safeJson(text: string | undefined): unknown {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}
