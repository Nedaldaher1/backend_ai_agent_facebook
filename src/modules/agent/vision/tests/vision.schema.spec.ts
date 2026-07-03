import {
  buildVisionAttributeSchema,
  EMPTY_VISION_ENUMS,
} from '../vision.schema';

describe('buildVisionAttributeSchema', () => {
  const enums = {
    colorFamilies: ['red', 'black'],
    occasions: ['سهرة'],
    fabrics: ['crepe'],
  };

  const valid = {
    isClothing: true,
    confidence: 0.8,
    color: 'red',
    occasion: 'سهرة',
    fabric: 'crepe',
    sleeveType: null,
    embellishment: null,
  };

  it('accepts an object whose color is within the closed enum', () => {
    expect(buildVisionAttributeSchema(enums).safeParse(valid).success).toBe(
      true,
    );
  });

  it('rejects a color outside the closed enum', () => {
    const r = buildVisionAttributeSchema(enums).safeParse({
      ...valid,
      color: 'turquoise',
    });
    expect(r.success).toBe(false);
  });

  it('allows a null color (design unclear)', () => {
    const r = buildVisionAttributeSchema(enums).safeParse({
      ...valid,
      color: null,
    });
    expect(r.success).toBe(true);
  });

  it('widens color to a free string when the catalog is empty', () => {
    const r = buildVisionAttributeSchema(EMPTY_VISION_ENUMS).safeParse({
      ...valid,
      color: 'anything',
    });
    expect(r.success).toBe(true);
  });

  it('requires isClothing and confidence', () => {
    expect(
      buildVisionAttributeSchema(enums).safeParse({ color: 'red' }).success,
    ).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    const r = buildVisionAttributeSchema(enums).safeParse({
      ...valid,
      confidence: 1.5,
    });
    expect(r.success).toBe(false);
  });
});
