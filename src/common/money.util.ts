/**
 * money.util.ts — Integer-based JOD arithmetic helpers (single source of truth).
 *
 * JOD uses three decimal places. All arithmetic here works in integer milli-JOD
 * (1 JOD = 1000 milli-JOD) so there is never any floating-point rounding.
 *
 * Rule (CLAUDE.md §3): money is a STRING end-to-end in this project. These
 * functions accept and return strings shaped like the catalog's PRICE_JOD_REGEX
 * ("45", "45.5", "45.250"); only the intermediate arithmetic is integer milli.
 */

/**
 * Convert a JOD price string to an integer milli-JOD value.
 * "45" → 45000, "45.5" → 45500, "45.250" → 45250.
 */
export function jodToMilli(priceJod: string): number {
  const dotIndex = priceJod.indexOf('.');
  if (dotIndex === -1) {
    // No decimal part — multiply whole-JOD by 1000.
    return parseInt(priceJod, 10) * 1000;
  }
  const wholePart = priceJod.slice(0, dotIndex);
  // Right-pad the fractional part to exactly 3 digits.
  const fracRaw = priceJod.slice(dotIndex + 1);
  const frac = fracRaw.padEnd(3, '0').slice(0, 3);
  return parseInt(wholePart, 10) * 1000 + parseInt(frac, 10);
}

/** Convert an integer milli-JOD value back to a 3-decimal JOD string. 45250 → "45.250". */
export function milliToJod(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = (milli % 1000).toString().padStart(3, '0');
  return `${whole}.${frac}`;
}

/** Multiply a unit price by an integer quantity. "45.250" × 2 → "90.500". */
export function multiplyJodByQty(priceJod: string, qty: number): string {
  return milliToJod(jodToMilli(priceJod) * qty);
}

/** Sum a list of JOD strings. ["90.000", "3.000"] → "93.000". */
export function sumJod(values: string[]): string {
  return milliToJod(values.reduce((acc, v) => acc + jodToMilli(v), 0));
}

/** Add two JOD strings. addJod("90.000", "3.000") → "93.000". */
export function addJod(a: string, b: string): string {
  return milliToJod(jodToMilli(a) + jodToMilli(b));
}

/**
 * Sum a list of line-totals (price × qty) using integer milli-JOD arithmetic.
 * Returns the total formatted as a 3-decimal JOD string.
 *
 * @example
 *   sumJodLineTotals([{ priceJod: '45', qty: 2 }, { priceJod: '12.500', qty: 1 }])
 *   // → "102.500"
 */
export function sumJodLineTotals(
  lines: { priceJod: string; qty: number }[],
): string {
  const totalMilli = lines.reduce(
    (acc, { priceJod, qty }) => acc + jodToMilli(priceJod) * qty,
    0,
  );
  return milliToJod(totalMilli);
}
