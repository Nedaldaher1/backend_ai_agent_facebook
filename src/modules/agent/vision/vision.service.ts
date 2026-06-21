/**
 * VisionService — extracts structured attributes from a customer-sent product
 * image using Claude Haiku, so the agent can search the catalog by what the
 * customer actually photographed.
 *
 * Design:
 *  - Runs as a deterministic PRE-GENERATE step (called from AgentService when an
 *    image is present), NOT as an agent tool — image presence is known up front
 *    and the workflow models it as a fixed branch.
 *  - Closed-enum schema (color, size) is sourced from the catalog at runtime and
 *    cached briefly (mirrors AgentBehaviorService's 60s instruction cache).
 *  - NEVER throws: every failure path returns { attributes: null, reason } so the
 *    customer's turn always proceeds (mirrors find_similar_by_image's best-effort
 *    contract).
 *
 * The live model call cannot be exercised in dev (the ANTHROPIC_API_KEY is a
 * placeholder → 401); correctness here is covered by unit tests with a mocked
 * agent, and the schema/transport shape is verified against Anthropic + Mastra
 * type defs. Validate end-to-end once a real key is configured.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from '@mastra/core/agent';
import { ProductsService } from '@/modules/products/products.service';
import { ColorsService } from '@/modules/products/colors.service';
import { SizingService } from '@/modules/sizing/sizing.service';
import { downloadImage } from './image-download.util';
import {
  buildVisionAttributeSchema,
  EMPTY_VISION_ENUMS,
  type VisionAttributes,
  type VisionEnums,
} from './vision.schema';

/** Why extraction yielded no usable attributes (for the agent + telemetry). */
export type VisionDegradeReason =
  | 'disabled'
  | 'fetch_failed'
  | 'model_failed'
  | 'not_a_product'
  | 'low_confidence';

/**
 * Outcome of a vision extraction.
 *  - `attributes` is null whenever there is nothing usable to seed the search.
 *  - `attributes.colorFamily` is the normalized canonical family (added here).
 *  - `reason` explains a null/low-confidence result.
 */
export interface VisionExtractResult {
  attributes: (VisionAttributes & { colorFamily?: string }) | null;
  confidence: number | null;
  reason?: VisionDegradeReason;
}

const VISION_SYSTEM_PROMPT =
  'أنتِ محلّلة صور لمتجر عبايات نسائية. مهمتك وصف العباية في الصورة بسمات مُهيكلة ' +
  'عبر المخطط المطلوب فقط. اختاري اللون والمقاس من القوائم المغلقة المعطاة حصراً، ' +
  'وضعي null لأي سمة غير واضحة. إن لم تكن الصورة لعباية أو منتج من المتجر فاضبطي ' +
  'isAbaya=false. لا تخمّني، وعبّري عن مدى ثقتك في الحقل confidence.';

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);

  private readonly enabled: boolean;
  private readonly modelId: string;
  private readonly minConfidence: number;
  private readonly maxImageBytes: number;
  private readonly fetchTimeoutMs: number;
  private readonly enumsTtlMs: number;

  private agent?: Agent;
  private enumsCache?: { value: VisionEnums; expiresAt: number };

  constructor(
    private readonly config: ConfigService,
    private readonly products: ProductsService,
    private readonly colors: ColorsService,
    private readonly sizing: SizingService,
  ) {
    this.enabled = this.config.get<string>('VISION_ENABLED') !== 'false';
    this.modelId =
      this.config.get<string>('VISION_MODEL_ID') ??
      'anthropic/claude-haiku-4-5';
    this.minConfidence = Number(
      this.config.get<string>('VISION_MIN_CONFIDENCE') ?? '0.4',
    );
    this.maxImageBytes = Number(
      this.config.get<string>('VISION_MAX_IMAGE_BYTES') ?? '5000000',
    );
    this.fetchTimeoutMs = Number(
      this.config.get<string>('VISION_FETCH_TIMEOUT_MS') ?? '8000',
    );
    this.enumsTtlMs = Number(
      this.config.get<string>('VISION_ENUMS_TTL_MS') ?? '60000',
    );
  }

  /**
   * Extract structured attributes from a customer image URL. NEVER throws —
   * every failure path returns { attributes: null, reason }.
   */
  async extractAttributes(input: { url: string }): Promise<VisionExtractResult> {
    if (!this.enabled) {
      return { attributes: null, confidence: null, reason: 'disabled' };
    }

    // 1. Fetch the image (temporary URL → bytes → base64 for the model).
    let image: { buffer: Buffer; mediaType: string };
    try {
      image = await downloadImage(input.url, {
        maxBytes: this.maxImageBytes,
        timeoutMs: this.fetchTimeoutMs,
      });
    } catch (err) {
      this.logger.warn(
        `vision: image fetch failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { attributes: null, confidence: null, reason: 'fetch_failed' };
    }

    // 2. Build the (cached) closed-enum schema from the catalog.
    let enums: VisionEnums;
    try {
      enums = await this.getEnums();
    } catch (err) {
      this.logger.warn(
        `vision: enum load failed, using permissive schema — ${String(err)}`,
      );
      enums = EMPTY_VISION_ENUMS;
    }
    const schema = buildVisionAttributeSchema(enums);

    // 3. Ask Haiku for structured attributes.
    let parsed: VisionAttributes;
    try {
      const dataUrl = `data:${image.mediaType};base64,${image.buffer.toString('base64')}`;
      const result = await this.getAgent().generate(
        [
          {
            role: 'user',
            content: [
              { type: 'image', image: dataUrl, mediaType: image.mediaType },
              { type: 'text', text: this.buildUserPrompt(enums) },
            ],
          },
        ],
        { structuredOutput: { schema } },
      );
      // Mastra populates `.object` for structured output; fall back to parsing
      // the text so a provider returning JSON text still works.
      const raw =
        (result as { object?: unknown }).object ??
        this.safeJson((result as { text?: string }).text);
      const validated = schema.safeParse(raw);
      if (!validated.success) {
        this.logger.warn('vision: model output failed schema validation');
        return { attributes: null, confidence: null, reason: 'model_failed' };
      }
      parsed = validated.data;
    } catch (err) {
      this.logger.warn(
        `vision: model call failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { attributes: null, confidence: null, reason: 'model_failed' };
    }

    // 4. Guard non-products, then normalize the color to a canonical family.
    if (!parsed.isAbaya) {
      return {
        attributes: null,
        confidence: parsed.confidence,
        reason: 'not_a_product',
      };
    }

    let colorFamily: string | undefined;
    if (parsed.color) {
      try {
        colorFamily = await this.products.normalizeColor(parsed.color);
      } catch {
        colorFamily = parsed.color;
      }
    }

    return {
      attributes: { ...parsed, colorFamily },
      confidence: parsed.confidence,
      reason:
        parsed.confidence < this.minConfidence ? 'low_confidence' : undefined,
    };
  }

  /** Lazily build the extraction agent (boots that never see an image pay nothing). */
  private getAgent(): Agent {
    if (!this.agent) {
      this.agent = new Agent({
        id: 'vision-extractor',
        name: 'Masa Vision Extractor',
        instructions: VISION_SYSTEM_PROMPT,
        model: this.modelId,
      });
    }
    return this.agent;
  }

  /** Catalog-sourced enums, cached with a short TTL (mirrors agent_behavior). */
  private async getEnums(): Promise<VisionEnums> {
    if (this.enumsCache && Date.now() < this.enumsCache.expiresAt) {
      return this.enumsCache.value;
    }
    const [colorFamilies, sizes, occasions, fabrics] = await Promise.all([
      this.colors.listActiveFamilies(),
      this.sizing.listSizeCodes(),
      this.products.distinctPublishedAttribute('occasion'),
      this.products.distinctPublishedAttribute('fabric'),
    ]);
    const value: VisionEnums = { colorFamilies, sizes, occasions, fabrics };
    this.enumsCache = { value, expiresAt: Date.now() + this.enumsTtlMs };
    return value;
  }

  private buildUserPrompt(enums: VisionEnums): string {
    const lines = [
      'حلّلي صورة العباية واملئي السمات وفق المخطط.',
      `الألوان المسموحة (اختاري الأقرب أو null): ${enums.colorFamilies.join('، ') || '—'}`,
      `المقاسات المسموحة: ${enums.sizes.join('، ') || '—'}`,
    ];
    if (enums.occasions.length) {
      lines.push(`أمثلة مناسبات شائعة: ${enums.occasions.join('، ')}`);
    }
    if (enums.fabrics.length) {
      lines.push(`أمثلة أقمشة شائعة: ${enums.fabrics.join('، ')}`);
    }
    return lines.join('\n');
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
