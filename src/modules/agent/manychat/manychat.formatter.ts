/**
 * Formats an agent reply into a ManyChat Dynamic Block (v2): the reply text plus
 * an optional product-card gallery. Pure + side-effect free so it is fully unit
 * tested; the controller owns I/O (calling the agent, resolving image URLs).
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
}

/** ManyChat caps a gallery at 10 cards. */
const MAX_CARDS = 10;

/**
 * Build the Dynamic Block. An empty reply with no products yields an empty
 * `messages` array (ManyChat sends nothing) — this is the dedup/no-op path.
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

  return { version: 'v2', content: { messages } };
}
