import {
  buildVisionAttributeSchema,
  EMPTY_VISION_ENUMS,
} from '../vision.schema';

describe('buildVisionAttributeSchema', () => {
  const enums = {
    colorFamilies: ['red', 'black'],
    sizes: ['1', '2'],
    occasions: ['سهرة'],
    fabrics: ['crepe'],
  };

  const valid = {
    isAbaya: true,
    confidence: 0.8,
    color: 'red',
    size: '1',
    occasion: 'سهرة',
    fabric: 'crepe',
    sleeveType: null,
    embellishment: null,
  };

  it('accepts an object whose color/size are within the closed enums', () => {
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

  it('rejects a size outside the closed enum', () => {
    const r = buildVisionAttributeSchema(enums).safeParse({
      ...valid,
      size: '99',
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

  it('widens color/size to free strings when the catalog is empty', () => {
    const r = buildVisionAttributeSchema(EMPTY_VISION_ENUMS).safeParse({
      ...valid,
      color: 'anything',
      size: 'XXL',
    });
    expect(r.success).toBe(true);
  });

  it('requires isAbaya and confidence', () => {
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
