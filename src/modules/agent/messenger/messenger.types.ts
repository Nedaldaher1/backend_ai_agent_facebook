/**
 * TypeScript interfaces for the Meta Messenger Platform inbound payload (Graph
 * API v25.0) and an internal normalized InboundMessage type.
 *
 * Raw types model what Meta POSTs to the webhook (strict subset — only the
 * fields we actually read). Unknown additional fields are allowed at runtime
 * (Meta adds fields over time); the zod schema uses .passthrough() for that.
 *
 * InboundMessage is the normalized internal type passed between the normalizer,
 * the controller, and the debounce buffer.
 */

// ---------------------------------------------------------------------------
// Raw Meta webhook shape
// ---------------------------------------------------------------------------

export interface RawAdsContextData {
  ad_title?: string;
  photo_url?: string;
  video_url?: string;
  post_id?: string;
  product_id?: string;
  flow_id?: string;
}

export interface RawReferral {
  ref?: string;
  ad_id?: string;
  source?: string;
  type?: string;
  ads_context_data?: RawAdsContextData;
}

export interface RawAttachmentPayload {
  url?: string;
  [key: string]: unknown;
}

export interface RawAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'location' | 'fallback' | string;
  payload?: RawAttachmentPayload;
}

export interface RawQuickReply {
  content_type: string;
  payload?: string;
  title?: string;
}

export interface RawMessage {
  mid: string;
  text?: string;
  attachments?: RawAttachment[];
  quick_reply?: RawQuickReply;
  referral?: RawReferral;
}

export interface RawPostback {
  title?: string;
  payload?: string;
  referral?: RawReferral;
}

export interface RawMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: RawMessage;
  postback?: RawPostback;
  referral?: RawReferral;
}

export interface RawEntry {
  id: string;
  time: number;
  messaging: RawMessagingEvent[];
}

export interface RawWebhookBody {
  object: string;
  entry: RawEntry[];
}

// ---------------------------------------------------------------------------
// Internal normalized type
// ---------------------------------------------------------------------------

/**
 * Structured referral extracted from the Messenger event.
 * WS3 will persist ads_context_data columns; in WS2 we normalize and carry
 * the data so the agent's adRef field receives referral.ref.
 */
export interface NormalizedReferral {
  /** The ref slug set in the ad / Messenger Ref URL. Maps to agent adRef. */
  ref?: string;
  adId?: string;
  source?: string;
  type?: string;
  adsContext?: RawAdsContextData;
}

/**
 * Normalized inbound message — the clean internal representation passed to
 * DebounceService and AgentService. All fields from the raw Meta payload that
 * the agent needs are extracted and typed here; the controller and normalizer
 * never let the raw Meta shape leak past this boundary.
 */
export interface InboundMessage {
  /** Facebook PSID (sender.id). Maps to IncomingMessage.contactId. */
  psid: string;
  /** Message text (or postback/quick-reply payload folded in). */
  text: string;
  /** URL of the first image attachment, when present. */
  imageUrl?: string;
  /** URL of the first audio attachment (voice note), when present. */
  audioUrl?: string;
  /** Messenger mid — used as idempotency key. */
  mid?: string;
  /** Event timestamp from Meta (epoch ms). */
  timestamp?: number;
  /** Customer name (not available from the webhook event; set to undefined). */
  name?: string;
  /** Extracted referral data (precedence: message.referral > event.referral > postback.referral). */
  referral?: NormalizedReferral;
}
