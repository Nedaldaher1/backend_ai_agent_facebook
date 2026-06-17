/**
 * Pure unit tests for sumJodLineTotals — no mocks needed (no I/O).
 */
import { sumJodLineTotals } from '../money.util';

describe('sumJodLineTotals', () => {
  it('returns "0.000" for an empty array', () => {
    expect(sumJodLineTotals([])).toBe('0.000');
  });

  it('multiplies a whole-JOD price by qty correctly', () => {
    // 45 × 2 = 90 JOD
    expect(sumJodLineTotals([{ priceJod: '45', qty: 2 }])).toBe('90.000');
  });

  it('handles decimal prices with a single fractional digit', () => {
    // 45.5 × 1 = 45.500, 12.250 × 2 = 24.500 → total 70.000
    expect(
      sumJodLineTotals([
        { priceJod: '45.5', qty: 1 },
        { priceJod: '12.250', qty: 2 },
      ]),
    ).toBe('70.000');
  });

  it('handles three decimal places correctly', () => {
    // 45.05 × 3 = 135.150
    expect(sumJodLineTotals([{ priceJod: '45.05', qty: 3 }])).toBe('135.150');
  });

  it('carries correctly across the milli boundary without float drift', () => {
    // 0.999 × 1000 = 999.000 exactly (integer arithmetic, no float rounding)
    expect(
      sumJodLineTotals([{ priceJod: '0.999', qty: 1000 }]),
    ).toBe('999.000');
  });
});
