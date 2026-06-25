import { stripImageMarkup } from '../reply-sanitize.util';

describe('stripImageMarkup', () => {
  it('removes a markdown image embed and keeps the surrounding text', () => {
    const input =
      'خليني أجيب صورته:\n![صورة 1](https://pub-caf.r2.dev/848229a9.jpeg)\nبتحبي تطلبيها؟';
    // The removed image line folds to a single paragraph break.
    expect(stripImageMarkup(input)).toBe(
      'خليني أجيب صورته:\n\nبتحبي تطلبيها؟',
    );
  });

  it('collapses the two --- separators that wrapped a removed image block', () => {
    const input = [
      '📌 الفئة: يومي',
      '',
      '---',
      '',
      '![صورة 1](https://pub-caf.r2.dev/a.jpeg)',
      '![صورة 2](https://pub-caf.r2.dev/b.jpeg)',
      '',
      '---',
      '',
      'بتحبي تطلبيها؟',
    ].join('\n');
    // Exactly one separator survives between the details and the closing line.
    expect(stripImageMarkup(input)).toBe(
      '📌 الفئة: يومي\n\n---\n\nبتحبي تطلبيها؟',
    );
  });

  it('removes several markdown images (the reported bug) and collapses blank runs', () => {
    const input = [
      '*عباية صيفي*',
      '---',
      '![صورة 1](https://pub-caf.r2.dev/a.jpeg)',
      '![صورة 2](https://pub-caf.r2.dev/b.jpeg)',
      '![صورة 3](https://pub-caf.r2.dev/c.jpeg)',
      '---',
      'بتحبي تطلبيها؟',
    ].join('\n');

    const out = stripImageMarkup(input);

    expect(out).not.toContain('http');
    expect(out).not.toContain('![');
    expect(out).toContain('*عباية صيفي*');
    expect(out).toContain('بتحبي تطلبيها؟');
    expect(out).not.toMatch(/\n{3,}/); // no 3+ newline runs left behind
  });

  it('removes a bare image URL (no markdown wrapper)', () => {
    const out = stripImageMarkup('شوفي هاي https://pub-caf.r2.dev/x.png حلوة');
    expect(out).not.toContain('http');
    expect(out).toContain('شوفي هاي');
    expect(out).toContain('حلوة');
  });

  it('leaves text without image markup unchanged', () => {
    const input = 'اللون: أخضر\nالسعر: 12 دينار\nالفئة: يومي';
    expect(stripImageMarkup(input)).toBe(input);
  });

  it('does not strip a non-image URL', () => {
    const input = 'تفضلي الموقع https://masafashion.com للطلب';
    expect(stripImageMarkup(input)).toBe(input);
  });

  it('returns empty/falsy input unchanged', () => {
    expect(stripImageMarkup('')).toBe('');
  });
});
