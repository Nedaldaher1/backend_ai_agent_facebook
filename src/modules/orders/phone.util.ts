/**
 * Jordanian mobile-number validation + normalization.
 *
 * Customers type their number many ways: 0791234567, +962 79 123 4567,
 * 00962791234567, 962-79-1234567. We store ONE canonical form so an order's
 * phone is unambiguous and dedup-able: `+9627XXXXXXXX` (E.164).
 *
 * A valid Jordanian mobile national-significant-number is `7[789]XXXXXXX`
 * (Zain/Orange/Umniah prefixes 77/78/79 + 7 digits). Anything else is rejected.
 */

/** Canonical national-significant-number shape: 7, then 7/8/9, then 7 digits. */
const JO_MOBILE_NSN = /^7[789]\d{7}$/;

/**
 * Normalize a raw phone string to canonical `+9627XXXXXXXX`, or return `null`
 * when it is not a valid Jordanian mobile number.
 */
export function normalizeJordanMobile(raw: string): string | null {
  if (!raw) return null;

  // Tolerate spaces, dashes, and parentheses anywhere in the input.
  let s = raw.trim().replace(/[\s\-()]/g, '');

  // Strip the international prefix to a bare number: '+962…' / '00962…' → '962…'.
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);

  // Everything left must be digits.
  if (!/^\d+$/.test(s)) return null;

  // Reduce to the national-significant-number (drop country/trunk prefix).
  let nsn: string;
  if (s.startsWith('962')) {
    nsn = s.slice(3);
  } else if (s.startsWith('0')) {
    nsn = s.slice(1);
  } else {
    nsn = s;
  }

  if (!JO_MOBILE_NSN.test(nsn)) return null;
  return `+962${nsn}`;
}
