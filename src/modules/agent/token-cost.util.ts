/**
 * Token → USD cost estimation for per-turn observability.
 *
 * Prices are USD per MILLION tokens, sourced from openrouter.ai/models
 * (checked 2026-07). `cachedInPerM` is the discounted rate OpenRouter bills
 * for provider-cached prompt-prefix reads (Gemini implicit cache reads bill
 * at 0.1x of normal input here — a major reason to keep the prompt prefix
 * byte-stable across turns).
 *
 * This is an ESTIMATE for logs and eval comparisons only — OpenRouter's
 * invoice is authoritative. Unknown model ids yield `undefined` so a stale
 * constant can never silently misreport a cost of 0.
 *
 * Audio caveat: rates here are TEXT-token rates. Gemini bills audio input
 * tokens at a higher rate (~2x text), so estimates for transcription turns
 * (audio file parts) are understated — the invoice remains authoritative.
 */

/** USD per million tokens for one model. */
export interface ModelPricing {
  inPerM: number;
  cachedInPerM: number;
  outPerM: number;
}

/** Normalized per-turn usage (field names already unified by the caller). */
export interface TurnUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Price table keyed WITHOUT the 'openrouter/' router prefix (stripped by
 * normalizeModelId). Update alongside any *_MODEL_ID default change.
 */
const MODEL_PRICES: Record<string, ModelPricing> = {
  'google/gemini-3.5-flash': { inPerM: 1.5, cachedInPerM: 0.15, outPerM: 9 },
  'google/gemini-3.1-flash-lite': {
    inPerM: 0.25,
    cachedInPerM: 0.025,
    outPerM: 1.5,
  },
  'google/gemini-2.5-flash': { inPerM: 0.3, cachedInPerM: 0.03, outPerM: 2.5 },
  'google/gemini-2.5-flash-lite': {
    inPerM: 0.1,
    cachedInPerM: 0.01,
    outPerM: 0.4,
  },
};

/** Strip Mastra's router prefix: 'openrouter/google/x' → 'google/x'. */
function normalizeModelId(modelId: string): string {
  return modelId.replace(/^openrouter\//, '');
}

/**
 * Estimated USD cost of one turn. `inputTokens` is the TOTAL prompt size as
 * reported by the provider (cached tokens included), so the cached share is
 * priced at the discount and only the remainder at the full input rate.
 * Returns undefined for unknown models or absent usage.
 */
export function estimateCostUsd(
  modelId: string,
  usage: TurnUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  const pricing = MODEL_PRICES[normalizeModelId(modelId)];
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  // Defensive clamp: a provider must never report more cached than input.
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0) return undefined;
  return (
    ((input - cached) * pricing.inPerM +
      cached * pricing.cachedInPerM +
      output * pricing.outPerM) /
    1_000_000
  );
}

/**
 * Share of the prompt served from the provider cache [0..1], or undefined
 * when there was no input. The lever behind it: a byte-stable prompt prefix.
 */
export function cacheHitRate(usage: TurnUsage | undefined): number | undefined {
  const input = usage?.inputTokens ?? 0;
  if (input <= 0) return undefined;
  const cached = Math.min(usage?.cachedInputTokens ?? 0, input);
  return cached / input;
}

/**
 * Compact log suffix, e.g. ` estCost=$0.014210 cacheHit=42%`. Empty string
 * when nothing is estimable (unknown model / no usage) — never throws.
 */
export function formatCostMeta(
  modelId: string,
  usage: TurnUsage | undefined,
): string {
  const cost = estimateCostUsd(modelId, usage);
  const rate = cacheHitRate(usage);
  const parts: string[] = [];
  if (cost !== undefined) parts.push(`estCost=$${cost.toFixed(6)}`);
  if (rate !== undefined) parts.push(`cacheHit=${Math.round(rate * 100)}%`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
