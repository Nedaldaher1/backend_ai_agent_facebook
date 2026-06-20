/**
 * Pure unit tests for normalizeJordanMobile — no mocks (no I/O).
 * Canonical output form is +9627XXXXXXXX (E.164).
 */
import { normalizeJordanMobile } from '../phone.util';

describe('normalizeJordanMobile', () => {
  describe('accepts and normalizes valid Jordanian mobiles', () => {
    it.each([
      ['0791234567', '+962791234567'],
      ['0781234567', '+962781234567'],
      ['0771234567', '+962771234567'],
      ['+962791234567', '+962791234567'],
      ['00962791234567', '+962791234567'],
      ['962791234567', '+962791234567'],
      ['791234567', '+962791234567'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeJordanMobile(input)).toBe(expected);
    });

    it('tolerates spaces, dashes and parentheses', () => {
      expect(normalizeJordanMobile('+962 79 123 4567')).toBe('+962791234567');
      expect(normalizeJordanMobile('079-123-4567')).toBe('+962791234567');
      expect(normalizeJordanMobile('(079) 1234567')).toBe('+962791234567');
    });
  });

  describe('rejects invalid numbers (returns null)', () => {
    it.each([
      ['', 'empty'],
      ['0761234567', 'invalid prefix 076 (not 77/78/79)'],
      ['079123456', 'too short'],
      ['07912345678', 'too long'],
      ['0791234abc', 'non-digits'],
      ['+1234567890', 'non-Jordanian'],
      ['06123456', 'landline'],
    ])('%s (%s)', (input) => {
      expect(normalizeJordanMobile(input)).toBeNull();
    });
  });
});
