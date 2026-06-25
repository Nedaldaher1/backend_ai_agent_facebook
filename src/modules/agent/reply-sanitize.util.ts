/**
 * Reply text sanitisation for chat transports.
 *
 * WHY: the model sometimes pastes image markup into its reply — markdown embeds
 * `![alt](url)` or bare image URLs — to "show" product photos. Messenger (and
 * every chat transport here) renders neither as a picture; they appear as ugly
 * raw links. Product photos reach the customer ONLY through the carousel cards,
 * never the reply text, so we strip them DETERMINISTICALLY here instead of
 * trusting the prompt/tool descriptions.
 */

// Markdown image embed: ![alt](url) and ![alt](url "title").
const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
// Bare image URL: http(s)://… ending in a common image extension (+ optional query).
const BARE_IMAGE_URL = /https?:\/\/\S+\.(?:jpe?g|png|webp|gif|bmp|svg)(?:\?\S*)?/gi;
const SEPARATOR = /^-{3,}$/; // markdown horizontal rule line

/**
 * Remove image markup (markdown embeds + bare image URLs) from a reply and tidy
 * the whitespace the removal leaves behind: orphaned list bullets are dropped,
 * blank-line runs fold to a single blank, consecutive `---` separators (a whole
 * image block sat between two of them) collapse to one, and leading/trailing
 * blanks/separators are trimmed. Pure and best-effort.
 */
export function stripImageMarkup(text: string): string {
  if (!text) return text;
  const stripped = text.replace(MD_IMAGE, '').replace(BARE_IMAGE_URL, '');

  const out: string[] = [];
  let pendingBlank = false;
  let lastWasSeparator = false;

  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '');
    const trimmed = line.trim();

    // Blank line, or a bullet left orphaned by a removed image → fold into a
    // single pending blank (never accumulate runs).
    if (trimmed === '' || /^[-*•]$/.test(trimmed)) {
      pendingBlank = out.length > 0;
      continue;
    }

    // Collapse consecutive `---` separators (ignoring blanks between them) — e.g.
    // when the image block that sat between two separators has been removed.
    const isSeparator = SEPARATOR.test(trimmed);
    if (isSeparator && lastWasSeparator) {
      pendingBlank = false;
      continue;
    }

    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(line);
    lastWasSeparator = isSeparator;
  }

  // Trim blanks/separators left dangling at the very start or end.
  const isEdge = (l: string) => l.trim() === '' || SEPARATOR.test(l.trim());
  while (out.length && isEdge(out[0])) out.shift();
  while (out.length && isEdge(out[out.length - 1])) out.pop();

  return out.join('\n');
}
