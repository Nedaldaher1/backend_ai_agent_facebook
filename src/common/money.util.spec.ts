/**
 * Pure unit tests for the shared JOD money helpers — integer milli arithmetic,
 * string in / string out, no floating point.
 */
import {
  addJod,
  jodToMilli,
  milliToJod,
  multiplyJodByQty,
  sumJod,
  sumJodLineTotals,
} from './money.util';

describe('money.util', () => {
  describe('jodToMilli', () => {
    it.each([
      ['45', 45000],
      ['45.5', 45500],
      ['45.25', 45250],
      ['45.250', 45250],
      ['0', 0],
    ])('%s → %i', (input, expected) => {
      expect(jodToMilli(input)).toBe(expected);
    });
  });

  describe('milliToJod', () => {
    it.each([
      [45000, '45.000'],
      [45250, '45.250'],
      [3000, '3.000'],
      [0, '0.000'],
    ])('%i → %s', (input, expected) => {
      expect(milliToJod(input)).toBe(expected);
    });
  });

  describe('multiplyJodByQty', () => {
    it('45.250 × 2 = 90.500', () => {
      expect(multiplyJodByQty('45.250', 2)).toBe('90.500');
    });
    it('45 × 3 = 135.000', () => {
      expect(multiplyJodByQty('45', 3)).toBe('135.000');
    });
  });

  describe('sumJod', () => {
    it('sums a list of JOD strings', () => {
      expect(sumJod(['90.000', '3.000', '12.500'])).toBe('105.500');
    });
    it('empty list → 0.000', () => {
      expect(sumJod([])).toBe('0.000');
    });
  });

  describe('addJod', () => {
    it('adds two JOD strings (subtotal + delivery fee)', () => {
      expect(addJod('90.000', '2.500')).toBe('92.500');
    });
  });

  describe('sumJodLineTotals (back-compat)', () => {
    it('Σ price × qty', () => {
      expect(
        sumJodLineTotals([
          { priceJod: '45', qty: 2 },
          { priceJod: '12.500', qty: 1 },
        ]),
      ).toBe('102.500');
    });
  });
});
