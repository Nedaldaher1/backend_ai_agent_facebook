import {
  cacheHitRate,
  estimateCostUsd,
  formatCostMeta,
} from '../token-cost.util';

describe('token-cost.util', () => {
  const MODEL = 'openrouter/google/gemini-3.5-flash';

  describe('estimateCostUsd', () => {
    it('prices uncached input + output at the full rates', () => {
      // 1M in @ $1.5 + 1M out @ $9 = $10.5
      const cost = estimateCostUsd(MODEL, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(10.5, 6);
    });

    it('bills the cached share at the discounted rate', () => {
      // 1M input fully cached @ $0.15/M = $0.15 (vs $1.5 uncached)
      const cost = estimateCostUsd(MODEL, {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(cost).toBeCloseTo(0.15, 6);
    });

    it('clamps cached tokens to the reported input size', () => {
      const cost = estimateCostUsd(MODEL, {
        inputTokens: 100,
        cachedInputTokens: 500, // provider glitch — must not go negative
        outputTokens: 0,
      });
      expect(cost).toBeCloseTo((100 * 0.15) / 1_000_000, 12);
    });

    it('works with and without the openrouter/ router prefix', () => {
      const usage = { inputTokens: 1000, outputTokens: 100 };
      expect(estimateCostUsd('google/gemini-3.5-flash', usage)).toEqual(
        estimateCostUsd(MODEL, usage),
      );
    });

    it('returns undefined for unknown models and absent usage', () => {
      expect(
        estimateCostUsd('openrouter/unknown/model', { inputTokens: 10 }),
      ).toBeUndefined();
      expect(estimateCostUsd(MODEL, undefined)).toBeUndefined();
      expect(estimateCostUsd(MODEL, {})).toBeUndefined();
    });
  });

  describe('cacheHitRate', () => {
    it('is the cached share of input tokens', () => {
      expect(
        cacheHitRate({ inputTokens: 1000, cachedInputTokens: 400 }),
      ).toBeCloseTo(0.4, 6);
    });

    it('is undefined when there is no input', () => {
      expect(cacheHitRate(undefined)).toBeUndefined();
      expect(cacheHitRate({ inputTokens: 0 })).toBeUndefined();
    });
  });

  describe('formatCostMeta', () => {
    it('formats cost and cache share for the turn log line', () => {
      const meta = formatCostMeta(MODEL, {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 0,
      });
      expect(meta).toContain('estCost=$');
      expect(meta).toContain('cacheHit=50%');
    });

    it('returns an empty string when nothing is estimable', () => {
      expect(formatCostMeta('openrouter/unknown/model', undefined)).toBe('');
    });
  });
});
