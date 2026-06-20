/**
 * Unit test for the flat COD delivery fee (integer milli-JOD).
 */
import { DELIVERY_FEE_MILLI } from '../delivery-fees';

describe('DELIVERY_FEE_MILLI', () => {
  it('is a positive integer in milli-JOD (2.000 JOD)', () => {
    expect(Number.isInteger(DELIVERY_FEE_MILLI)).toBe(true);
    expect(DELIVERY_FEE_MILLI).toBe(2000);
  });
});
