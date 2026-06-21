/**
 * ManyChat "Dynamic Block" response (the custom JSON an External Request renders),
 * v2 schema: a list of messages — text and/or a card gallery.
 *
 * VERIFY against the connected ManyChat account: the exact field names and the
 * accepted message types can vary by ManyChat version/config. This models the
 * documented v2 text + gallery (cards) shape and is the single place to adjust
 * if the account expects a different layout.
 */

export interface ManyChatTextMessage {
  type: 'text';
  text: string;
}

export interface ManyChatCardButton {
  type: 'url';
  caption: string;
  url: string;
}

export interface ManyChatCard {
  title: string;
  subtitle?: string;
  image_url?: string;
  action_url?: string;
  buttons?: ManyChatCardButton[];
}

export interface ManyChatCardsMessage {
  type: 'cards';
  elements: ManyChatCard[];
  image_aspect_ratio?: 'horizontal' | 'square';
}

export type ManyChatMessage = ManyChatTextMessage | ManyChatCardsMessage;

export interface ManyChatDynamicBlock {
  version: 'v2';
  content: {
    messages: ManyChatMessage[];
    actions?: unknown[];
    quick_replies?: unknown[];
  };
}
