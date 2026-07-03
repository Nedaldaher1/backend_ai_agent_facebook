import { stripEmojis, stripImageMarkup } from '../reply-sanitize.util';

describe('stripImageMarkup', () => {
  it('removes a markdown image embed and keeps the surrounding text', () => {
    const input =
      'خليني أجيب صورته:\n![صورة 1](https://pub-caf.r2.dev/848229a9.jpeg)\nبتحبي تطلبيها؟';
    // The removed image line folds to a single paragraph break.
    expect(stripImageMarkup(input)).toBe('خليني أجيب صورته:\n\nبتحبي تطلبيها؟');
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

describe('stripEmojis', () => {
  // \u escapes (not literal emoji) so the source is unambiguous about codepoints.
  const HEART = '\u{1F5A4}'; // 🖤
  const SPARKLES = '\u2728'; // sparkles
  const FLOWER = '\u{1F338}'; // 🌸
  const OK_HAND = '\u{1F44C}'; // 👌
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // ZWJ sequence (family emoji)
  const THUMB_TONE = '\u{1F44D}\u{1F3FD}'; // 👍🏽 (skin-tone modifier)
  const FLAG_JO = '\u{1F1EF}\u{1F1F4}'; // 🇯🇴 (regional-indicator pair)

  it('removes an inline emoji and collapses the leftover double space', () => {
    expect(stripEmojis(`سعرها 22 دينار ${HEART} والتوصيل 2 دينار`)).toBe(
      'سعرها 22 دينار والتوصيل 2 دينار',
    );
  });

  it('removes several different emoji in one string', () => {
    expect(stripEmojis(`${SPARKLES}مرحبا ${FLOWER} كيفك ${OK_HAND}`)).toBe(
      'مرحبا كيفك',
    );
  });

  it('removes ZWJ sequences, skin-tone modifiers, and flag pairs', () => {
    expect(stripEmojis(`أهلا ${FAMILY}${THUMB_TONE}${FLAG_JO} بيكي`)).toBe(
      'أهلا بيكي',
    );
  });

  it('keeps Arabic-Indic and ASCII numerals (digits are not stripped)', () => {
    expect(stripEmojis(`الطلب رقم #3 بسعر ٢٢ و 22 دينار ${OK_HAND}`)).toBe(
      'الطلب رقم #3 بسعر ٢٢ و 22 دينار',
    );
  });

  it('preserves newlines so bubble boundaries survive', () => {
    expect(stripEmojis(`سطر ${HEART}\n\nسطر تاني`)).toBe('سطر\n\nسطر تاني');
  });

  it('leaves emoji-free Arabic text unchanged', () => {
    const input = 'اللون أخضر، السعر 12 دينار، الفئة يومي';
    expect(stripEmojis(input)).toBe(input);
  });

  it('returns empty/falsy input unchanged', () => {
    expect(stripEmojis('')).toBe('');
  });
});
