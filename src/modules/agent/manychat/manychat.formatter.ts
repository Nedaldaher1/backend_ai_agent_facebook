/**
 * Formats an agent reply into a ManyChat Dynamic Block (v2): the reply text plus
 * an optional product-card gallery. Pure + side-effect free so it is fully unit
 * tested; the controller owns I/O (calling the agent, resolving image URLs).
 *
 * ManyChat Dynamic Block limits (enforced defensively here):
 *  - messages      : ≤10
 *  - gallery cards : ≤10  (MAX_CARDS)
 *  - buttons/card  : ≤3   (not emitted yet — enforced when added)
 *  - quick_replies : ≤11  (not emitted yet — enforced when added)
 *  - actions       : ≤5   (not emitted yet — enforced when added)
 *
 * The `content.actions` and `content.quick_replies` arrays are ALWAYS present
 * (empty) to match the v2 contract shape exactly (Messenger channel, no
 * `content.type`).
 */

import type {
  ManyChatCard,
  ManyChatDynamicBlock,
  ManyChatMessage,
} from './manychat.types';

/** A product to render as a ManyChat card. */
export interface CardProduct {
  id: string;
  name: string;
  /** JOD numeric string (money is a string end-to-end; never a float). */
  price: string;
  imageUrl?: string;
}

export interface DynamicBlockInput {
  reply: string;
  products?: CardProduct[];
  /**
   * Number of matched products that could not be rendered due to the gallery cap.
   * When > 0 the formatter appends a short Arabic overflow note as a trailing
   * text message so the customer knows more options are available.
   */
  overflowCount?: number;
}

/** ManyChat caps a gallery at 10 cards. */
const MAX_CARDS = 10;

/** ManyChat caps the total message list at 10. */
const MAX_MESSAGES = 10;

/**
 * Build the overflow note text for N extra products.
 * Intentionally simple (no singular/plural branch): Arabic "N تصميم" is
 * grammatically acceptable for any positive N in Jordanian dialect.
 */
function overflowNote(count: number): string {
  return `وعندي كمان ${count} تصميم — قوليلي إذا بتحبي أعرضهنّ 🌸`;
}

/**
 * Build the Dynamic Block. An empty reply with no products yields an empty
 * `messages` array (ManyChat sends nothing) — this is the dedup/no-op path.
 *
 * `content.actions` and `content.quick_replies` are always present as empty
 * arrays so the shape exactly matches the v2 Messenger contract.
 *
 * When `overflowCount > 0` a trailing text message is appended with a short
 * Arabic note informing the customer that more designs are available. The total
 * still respects the ≤10 messages cap.
 */
export function toDynamicBlock(input: DynamicBlockInput): ManyChatDynamicBlock {
  const messages: ManyChatMessage[] = [];

  const text = input.reply?.trim();
  if (text) {
    messages.push({ type: 'text', text });
  }

  if (input.products && input.products.length > 0) {
    const elements: ManyChatCard[] = input.products
      .slice(0, MAX_CARDS)
      .map((p) => ({
        title: p.name,
        subtitle: `${p.price} د.أ`,
        ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
      }));
    messages.push({ type: 'cards', elements, image_aspect_ratio: 'square' });
  }

  // Append the overflow note BEFORE the hard cap so it is included only when
  // there is room. If the messages array is already at MAX_MESSAGES (rare),
  // the note is silently dropped rather than violating the ManyChat limit.
  if (input.overflowCount && input.overflowCount > 0) {
    messages.push({ type: 'text', text: overflowNote(input.overflowCount) });
  }

  return {
    version: 'v2',
    content: {
      // Defensive cap: ManyChat rejects blocks with >10 messages.
      messages: messages.slice(0, MAX_MESSAGES),
      // Always-present per the v2 contract (Messenger, no content.type).
      actions: [],
      quick_replies: [],
    },
  };
}
