/**
 * Pure formatter: agent reply → ordered list of Messenger Send API payloads.
 *
 * Produces (in order):
 *  1. A text message carrying the reply.
 *  2. (Optional) A generic-template carousel of product cards, using the R2
 *     image URLs resolved by the controller. Cap is MAX_GALLERY_CARDS (8).
 *  3. (Optional) An Arabic overflow note when more products matched than fit in
 *     the carousel.
 *
 * Pure + side-effect-free — no I/O, no logging. Fully unit-testable.
 */

import type { TemplateElement } from './messenger.client';

/**
 * Maximum number of product cards rendered in a Messenger generic-template
 * carousel. The Messenger Platform hard-limits generic templates to 10 elements;
 * we use 8 to leave headroom and keep the UX scannable.
 *
 * AgentService imports this to cap the products it surfaces so the card count
 * and overflow math never drift between the formatter and the service.
 */
export const MAX_GALLERY_CARDS = 8;

/** A product card to render in the carousel. */
export interface MessengerCardProduct {
  id: string;
  name: string;
  /** JOD numeric string (money-as-string rule). */
  price: string;
  imageUrl?: string;
}

export interface MessengerFormatterInput {
  reply: string;
  products?: MessengerCardProduct[];
  /**
   * Number of matched products beyond the rendered cap. When > 0 an Arabic
   * overflow note is appended as a separate text payload.
   */
  overflowCount?: number;
}

/** A single Send API message payload (either text or generic template). */
export type MessengerPayload =
  | TextPayload
  | TemplatePayload;

interface TextPayload {
  kind: 'text';
  text: string;
}

interface TemplatePayload {
  kind: 'template';
  elements: TemplateElement[];
}

/** Arabic overflow note appended when more products matched than fit in the carousel. */
function overflowNote(count: number): string {
  return `وعندي كمان ${count} تصميم — قوليلي إذا بتحبي أعرضهنّ 🌸`;
}

/**
 * Build the ordered list of Send API payloads from an agent reply.
 * An empty reply with no products → empty array (no-op path).
 */
export function formatMessengerReply(
  input: MessengerFormatterInput,
): MessengerPayload[] {
  const payloads: MessengerPayload[] = [];

  const text = input.reply?.trim();
  if (text) {
    payloads.push({ kind: 'text', text });
  }

  if (input.products && input.products.length > 0) {
    const elements: TemplateElement[] = input.products
      .slice(0, MAX_GALLERY_CARDS)
      .map((p) => ({
        title: p.name,
        subtitle: `${p.price} د.أ`,
        ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
      }));
    payloads.push({ kind: 'template', elements });
  }

  if (input.overflowCount && input.overflowCount > 0) {
    payloads.push({ kind: 'text', text: overflowNote(input.overflowCount) });
  }

  return payloads;
}
