import { tokenizeSearchQuery } from '../search-tokenize.util';

describe('tokenizeSearchQuery', () => {
  it('returns [] for empty or whitespace input', () => {
    expect(tokenizeSearchQuery('')).toEqual([]);
    expect(tokenizeSearchQuery('   ')).toEqual([]);
  });

  it('drops dialect stopwords and keeps the meaningful catalog tokens', () => {
    // "I want a green abaya" → only the content words survive.
    expect(tokenizeSearchQuery('بدي عباية خضرا')).toEqual(['عباية', 'خضرا']);
  });

  it('returns [] when the query is ALL stopwords (browse intent → caller falls back)', () => {
    expect(tokenizeSearchQuery('بدي اشوف شو عندكم')).toEqual([]);
  });

  it('splits on Arabic and Latin punctuation and whitespace', () => {
    expect(tokenizeSearchQuery('عباية، سهرة. سوداء')).toEqual([
      'عباية',
      'سهرة',
      'سوداء',
    ]);
  });

  it('strips tatweel and diacritics so variants collapse', () => {
    // "عبايـة" (kashida) + "مُطرّزة" (harakat) → bare forms.
    expect(tokenizeSearchQuery('عبايـة مُطرّزة')).toEqual(['عباية', 'مطرزة']);
  });

  it('removes LIKE metacharacters (% _ \\) from tokens', () => {
    expect(tokenizeSearchQuery('عباية%_ سهرة')).toEqual(['عباية', 'سهرة']);
  });

  it('de-duplicates repeated tokens', () => {
    expect(tokenizeSearchQuery('عباية عباية سهرة')).toEqual(['عباية', 'سهرة']);
  });

  it('drops 1-character tokens', () => {
    expect(tokenizeSearchQuery('ا عباية')).toEqual(['عباية']);
  });

  it('caps the number of tokens at 8', () => {
    const q = 'عباية سهرة سوداء قطن تطريز زهور فضفاضة طويلة قصيرة واسعة';
    expect(tokenizeSearchQuery(q)).toHaveLength(8);
  });
});
