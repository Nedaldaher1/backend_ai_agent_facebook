/**
 * Arabic-aware tokenizer for free-text product search.
 *
 * WHY: pg_trgm `similarity(name, query)` collapses for Arabic natural-language
 * queries — the whole-sentence trigram overlap with a short product name is tiny
 * (e.g. "بدي اشوف العبايات" vs "عباية صيفي تطريز زهور" ≈ 0.07), so a single
 * 0.3 threshold returned NOTHING and the agent told customers "no products".
 * Matching per TOKEN with `word_similarity(token, name)` fixes it: a single
 * meaningful word like "عباية" scores 1.0 against the name.
 *
 * This splits a query into meaningful tokens: strips Arabic diacritics + tatweel,
 * drops 1-char tokens and common dialect stopwords ("بدي", "اشوف", …), removes
 * LIKE metacharacters, de-duplicates, and caps the count so the OR-ed SQL
 * predicate stays bounded.
 */

/** Common Jordanian/MSA filler words that carry no catalog signal. */
export const ARABIC_SEARCH_STOPWORDS = new Set<string>([
  // wants / requests
  'بدي', 'بدّي', 'بدنا', 'ابغى', 'أبغى', 'اريد', 'أريد', 'عايز', 'عايزة', 'حابة', 'حاب',
  // question words
  'شو', 'ايش', 'أيش', 'وش', 'شنو', 'كيف', 'وين', 'اي', 'أي',
  // see / show / give
  'اشوف', 'أشوف', 'شوف', 'فرجيني', 'فرجوني', 'اعرض', 'ورّيني', 'وريني', 'اعطيني', 'عطيني',
  // prepositions / particles
  'في', 'من', 'مع', 'على', 'عن', 'الى', 'إلى', 'عند', 'عندكم', 'عندكن', 'عندك', 'عندكو', 'الك', 'إلك',
  // demonstratives / relatives
  'الي', 'اللي', 'هاد', 'هاي', 'هذا', 'هذه', 'هدول', 'ذلك',
  // politeness / greetings
  'ممكن', 'بليز', 'لو', 'سمحت', 'يا', 'مرحبا', 'هلا', 'اهلا', 'أهلا',
  // negation / affirmation
  'ما', 'مو', 'مش', 'لا', 'نعم', 'اه', 'أه', 'ايوه',
]);

const DIACRITICS = /[ً-ْٰ]/g; // harakat/tanwin/shadda/sukun + superscript alef
const TATWEEL = /ـ/g; // ـ kashida
const SPLIT = /[\s،,.؛;:؟?!"'«»()[\]{}<>/\\|@#$^*+=~`-]+/u;
const LIKE_META = /[%_\\]/g;

/** Cap on OR-ed token predicates per query (bounds SQL size). */
const MAX_TOKENS = 8;

/**
 * Split a free-text query into meaningful, de-duplicated search tokens.
 * Returns [] for empty / whitespace / all-stopword input — the caller should
 * then fall back to a structured catalog list rather than a text search.
 */
export function tokenizeSearchQuery(query: string): string[] {
  if (!query) return [];
  const cleaned = query.replace(TATWEEL, '').replace(DIACRITICS, '');
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of cleaned.split(SPLIT)) {
    const t = part.replace(LIKE_META, '').trim();
    if (t.length < 2) continue;
    if (ARABIC_SEARCH_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}
