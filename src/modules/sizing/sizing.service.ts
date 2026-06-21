import { Injectable } from '@nestjs/common';
import { SizeChartRepository } from './size-chart.repository';

/**
 * Ceiling weight (kg) for the standard size chart.
 * Customers above this threshold are outside normal bands; the agent
 * should escalate to a human rather than guessing.
 * The top size band itself has no explicit upper bound — this constant
 * provides that guard.
 */
export const MAX_WEIGHT_KG = 120;

/**
 * The result returned by recommendSize to the calling tool.
 * `size` is null whenever the service cannot commit to a recommendation.
 */
export interface SizeRecommendation {
  size: string | null;
  note?: string; // short Arabic hint for the agent to relay to the customer
  needsHuman?: boolean; // true → unusual measurements; agent should escalate
}

@Injectable()
export class SizingService {
  constructor(private readonly repo: SizeChartRepository) {}

  /** Distinct size codes from the chart — the closed-enum size vocabulary. */
  listSizeCodes(): Promise<string[]> {
    return this.repo.distinctSizes();
  }

  /**
   * Recommends an abaya size given the customer's weight (and optionally
   * height, which is reserved for future refinement and unused today).
   *
   * Logic:
   *  1. Missing / invalid weightKg  → clarification response (no DB query).
   *  2. Empty chart                  → escalate (no bands configured).
   *  3. Out-of-range weight          → escalate (below floor or above ceiling).
   *  4. In-range weight              → greatest min_weight ≤ weightKg wins.
   *
   * ALL boundary checks and band-selection live here, never in a Mastra tool.
   *
   * @param weightKg  Customer's weight in kilograms (required for a result).
   * @param heightCm  Customer's height in centimetres — accepted but unused now;
   *                  kept for future size refinement without a breaking API change.
   */
  async recommendSize(
    weightKg?: number,
    // heightCm is accepted for API forward-compatibility but is not yet used
    // in the selection algorithm — reserved for a future two-axis size chart.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _heightCm?: number,
  ): Promise<SizeRecommendation> {
    // --- 1. Guard: weight must be a positive finite number ---
    if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) {
      return {
        size: null,
        note: 'بحاجة وزنك بالكيلو لأحدد المقاس المناسب.',
        // needsHuman is intentionally absent (falsy) — this is a clarification,
        // not an escalation.
      };
    }

    // --- 2. Load chart (desc by min_weight so find() works correctly) ---
    const rows = await this.repo.findAllOrderedByMinWeightDesc();

    if (rows.length === 0) {
      return {
        size: null,
        needsHuman: true,
        note: 'جدول المقاسات غير متوفر حالياً.',
      };
    }

    // --- 3. Derive floor from data (not a hardcoded constant) ---
    const minThreshold = Math.min(...rows.map((r) => r.minWeight));

    if (weightKg < minThreshold || weightKg > MAX_WEIGHT_KG) {
      return {
        size: null,
        needsHuman: true,
        note: 'وزنك خارج النطاق المعتاد لمقاساتنا، رح يساعدك فريقنا بالمقاس الأنسب.',
      };
    }

    // --- 4. Pick the greatest min_weight ≤ weightKg ---
    // Rows are desc by minWeight, so the first matching row is the answer.
    // A match is guaranteed because weightKg ≥ minThreshold ensures at least
    // the lowest band satisfies the condition.
    const match = rows.find((r) => weightKg >= r.minWeight)!;

    return { size: match.size };
  }
}
