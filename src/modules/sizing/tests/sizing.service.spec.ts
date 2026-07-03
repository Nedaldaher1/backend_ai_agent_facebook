import { SizingService } from '../sizing.service';
import type { ProductSize } from '@/modules/products/entities/product.entity';

// A weight-based size list (two numbered bands) plus a couple of letter sizes.
const WEIGHT_SIZES: ProductSize[] = [
  { label: '1', minWeightKg: 60, maxWeightKg: 90 },
  { label: '2', minWeightKg: 90, maxWeightKg: 120 },
];

const LETTER_SIZES: ProductSize[] = [
  { label: 'S' },
  { label: 'M' },
  { label: 'L' },
];

describe('SizingService.recommendSizeForProduct', () => {
  const service = new SizingService();

  // ---- weight-based sizing (positive path) --------------------------------

  it('picks the band that contains the weight', () => {
    expect(service.recommendSizeForProduct(WEIGHT_SIZES, 75)).toEqual({
      size: '1',
    });
    expect(service.recommendSizeForProduct(WEIGHT_SIZES, 100)).toEqual({
      size: '2',
    });
  });

  it('on an overlapping boundary the tighter lower bound wins', () => {
    // 90 is the max of band "1" and the min of band "2"; greatest min wins → "2".
    expect(service.recommendSizeForProduct(WEIGHT_SIZES, 90)).toEqual({
      size: '2',
    });
  });

  // ---- out of range -------------------------------------------------------

  it('escalates when the weight is outside every band', () => {
    const r = service.recommendSizeForProduct(WEIGHT_SIZES, 200);
    expect(r.size).toBeNull();
    expect(r.needsHuman).toBe(true);
    expect(r.note).toBeTruthy();
  });

  // ---- missing / invalid weight ------------------------------------------

  it('asks for the weight when it is missing/invalid (weighted product)', () => {
    for (const w of [undefined, 0, NaN]) {
      const r = service.recommendSizeForProduct(WEIGHT_SIZES, w);
      expect(r.size).toBeNull();
      expect(r.note).toBeTruthy();
      expect(r.needsHuman).toBeFalsy();
    }
  });

  // ---- letter-only product -----------------------------------------------

  it('lists the labels for a letter-only product (no weight bands)', () => {
    const r = service.recommendSizeForProduct(LETTER_SIZES, 75);
    expect(r.size).toBeNull();
    expect(r.needsHuman).toBeFalsy();
    expect(r.note).toContain('S');
    expect(r.note).toContain('L');
  });

  // ---- no sizes at all ----------------------------------------------------

  it('escalates when the product has no sizes', () => {
    for (const sizes of [undefined, null, []] as (
      | ProductSize[]
      | null
      | undefined
    )[]) {
      const r = service.recommendSizeForProduct(sizes, 75);
      expect(r.size).toBeNull();
      expect(r.needsHuman).toBe(true);
      expect(r.note).toBeTruthy();
    }
  });
});
