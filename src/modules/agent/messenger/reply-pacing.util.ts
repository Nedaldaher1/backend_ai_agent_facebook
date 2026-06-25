/**
 * Human-like reply pacing helpers for the Messenger transport.
 *
 * The agent's reply text is delivered as several short message bubbles with a
 * short "typing" pause between them (instead of one long message), so the
 * conversation feels human. These are PURE helpers — the controller owns the
 * actual sends + typing indicators; here we only decide the split and timings.
 */

/**
 * Split a reply into ordered bubbles on blank lines (paragraph breaks).
 *
 * The text is already sanitized upstream by stripImageMarkup (blank-line runs
 * folded to a single blank), so paragraphs are clean. Each part is trimmed and
 * empty parts are dropped. When there are more paragraphs than `maxBubbles`, the
 * overflow is merged (blank-line joined) into the last allowed bubble so we never
 * spam the customer. A single-paragraph reply returns one bubble; empty/whitespace
 * returns `[]` (caller sends nothing).
 */
export function splitIntoBubbles(text: string, maxBubbles: number): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 0) return [];

  const cap = Math.max(1, Math.floor(maxBubbles));
  if (parts.length <= cap) return parts;

  // Keep the first cap-1 bubbles; fold everything else into the last one.
  const head = parts.slice(0, cap - 1);
  const tail = parts.slice(cap - 1).join('\n\n');
  return [...head, tail];
}

/**
 * Typing-simulation delay (ms) for the next message: proportional to its
 * character `length` (length × perChar), clamped to [min, max]. A longer bubble
 * "types" longer; pass length 0 (e.g. for an image) to get the floor `min`.
 */
export function typingDelayMs(
  length: number,
  opts: { perChar: number; min: number; max: number },
): number {
  const raw = length * opts.perChar;
  return Math.min(opts.max, Math.max(opts.min, Math.round(raw)));
}

/** Resolve after `ms` (0 or less → next microtask, no timer scheduled). */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
