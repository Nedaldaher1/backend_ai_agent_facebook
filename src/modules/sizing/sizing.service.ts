import { Injectable } from '@nestjs/common';
import type { ProductSize } from '@/modules/products/entities/product.entity';

/**
 * The result returned by recommendSizeForProduct to the calling tool.
 * `size` is null whenever the service cannot commit to a single recommendation.
 */
export interface SizeRecommendation {
  size: string | null;
  note?: string; // short Arabic hint for the agent to relay to the customer
  needsHuman?: boolean; // true → unusual measurements; agent should escalate
}

/**
 * Per-product size recommendation.
 *
 * Sizing is no longer a single brand-wide weight chart: each product names its
 * own sizes and (for weight-based sizing) gives each a kg range. This service is
 * pure — it takes the product's own `sizes` list and the customer's weight and
 * picks the matching size. All boundary logic lives here, never in a Mastra tool.
 *
 * Cases:
 *  1. No sizes configured        → escalate (nothing to recommend).
 *  2. Letter-only sizes (no kg)  → list the labels and ask the customer to pick.
 *  3. Missing / invalid weight   → clarification (ask for the weight).
 *  4. Weight outside every range → escalate (unusual measurements).
 *  5. Weight inside a range      → the matching size (tightest lower bound wins).
 */
@Injectable()
export class SizingService {
  recommendSizeForProduct(
    sizes: ProductSize[] | null | undefined,
    weightKg?: number,
    // heightCm is accepted for API forward-compatibility but unused today —
    // reserved for a future two-axis size chart without a breaking change.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _heightCm?: number,
  ): SizeRecommendation {
    // --- 1. No sizes on this product ---
    if (!sizes || sizes.length === 0) {
      return {
        size: null,
        needsHuman: true,
        note: 'ما في مقاسات محدّدة لهذا المنتج حالياً، رح يساعدك فريقنا.',
      };
    }

    // Sizes that carry a weight band (at least one bound) can be matched by
    // weight; the rest are label-only (e.g. letter sizes S/M/L).
    const weighted = sizes.filter(
      (s) => s.minWeightKg != null || s.maxWeightKg != null,
    );

    // --- 2. Letter-only product: no weight bands, so ask the customer to pick ---
    if (weighted.length === 0) {
      const labels = sizes.map((s) => s.label).join('، ');
      return {
        size: null,
        note: `المقاسات المتوفّرة لهذا المنتج: ${labels}. أي مقاس بتحبّي؟`,
      };
    }

    // --- 3. Guard: weight must be a positive finite number ---
    if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) {
      return {
        size: null,
        note: 'بحاجة وزنك بالكيلو لأحدّد المقاس المناسب.',
      };
    }

    // --- 4/5. Pick the band that contains the weight (open-ended bounds allowed) ---
    const matches = weighted.filter(
      (s) =>
        (s.minWeightKg == null || weightKg >= s.minWeightKg) &&
        (s.maxWeightKg == null || weightKg <= s.maxWeightKg),
    );

    if (matches.length === 0) {
      return {
        size: null,
        needsHuman: true,
        note: 'وزنك خارج نطاق مقاسات هذا المنتج، رح يساعدك فريقنا بالمقاس الأنسب.',
      };
    }

    // On overlap, the tightest lower bound (greatest min) is the best fit.
    const best = matches.reduce((a, b) =>
      (b.minWeightKg ?? -Infinity) > (a.minWeightKg ?? -Infinity) ? b : a,
    );
    return { size: best.label };
  }
}
