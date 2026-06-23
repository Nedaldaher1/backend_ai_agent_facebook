/**
 * Pure normalizer for raw Meta Messenger Platform webhook events.
 *
 * Converts a raw RawMessagingEvent (from the validated POST body) into an
 * InboundMessage suitable for DebounceService + AgentService.handleMessage.
 *
 * Referral extraction precedence (constraint #5 from WS2 spec):
 *   1. event.message.referral  — brand-new user's first message from a
 *                                Click-to-Messenger ad (THE primary case).
 *   2. event.referral          — returning user's messaging_referrals event.
 *   3. event.postback.referral — Get-Started button case.
 *
 * Postback / quick-reply text folding:
 *  - A quick_reply: the payload is used as text (it is a machine-readable
 *    string we control; title is display-only). If no payload, title is used.
 *  - A postback: title is the human-readable label; payload is the machine
 *    code. We fold BOTH (title first) so the agent sees a natural phrase and
 *    the machine payload for routing, separated by a newline.
 *
 * Image extraction: first attachment of type 'image' wins; others are ignored.
 *
 * Pure + side-effect-free — no I/O, no logging. Fully unit-testable.
 */

import type {
  InboundMessage,
  NormalizedReferral,
  RawAdsContextData,
  RawMessagingEvent,
  RawReferral,
} from './messenger.types';

/** Normalize a raw referral object into NormalizedReferral. */
function normalizeReferral(raw: RawReferral | undefined): NormalizedReferral | undefined {
  if (!raw) return undefined;
  const adsContext: RawAdsContextData | undefined = raw.ads_context_data
    ? { ...raw.ads_context_data }
    : undefined;
  return {
    ...(raw.ref ? { ref: raw.ref } : {}),
    ...(raw.ad_id ? { adId: raw.ad_id } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.type ? { type: raw.type } : {}),
    ...(adsContext ? { adsContext } : {}),
  };
}

/**
 * Extract the referral from a raw event using the required precedence:
 *   message.referral > event.referral > postback.referral
 *
 * Exported so the controller can use it for content-less referral events
 * (messaging_referrals) that normalizeEvent returns null for, but where
 * first-touch attribution should still be persisted (WS3).
 */
export function extractReferral(event: RawMessagingEvent): NormalizedReferral | undefined {
  const raw =
    event.message?.referral ??
    event.referral ??
    event.postback?.referral;
  return normalizeReferral(raw);
}

/**
 * Extract the text for an event. Folds quick-reply and postback payloads so
 * the agent always has usable text, even without a literal message.text.
 */
function extractText(event: RawMessagingEvent): string {
  // Quick reply: payload is the machine string we control; title is display-only.
  // Use payload if available, otherwise title, otherwise fall back to message.text.
  if (event.message?.quick_reply) {
    const qr = event.message.quick_reply;
    return qr.payload ?? qr.title ?? event.message.text ?? '';
  }

  // Plain text message
  if (event.message?.text) {
    return event.message.text;
  }

  // Postback: fold title + payload so the agent sees both the human label
  // and the machine code. Title alone would lose routing info; payload alone
  // would be cryptic to the LLM.
  if (event.postback) {
    const parts: string[] = [];
    if (event.postback.title) parts.push(event.postback.title);
    if (event.postback.payload) parts.push(event.postback.payload);
    return parts.join('\n');
  }

  return '';
}

/**
 * Extract the URL of the first image attachment, if any.
 */
function extractImageUrl(event: RawMessagingEvent): string | undefined {
  const attachments = event.message?.attachments ?? [];
  const img = attachments.find((a) => a.type === 'image');
  return img?.payload?.url;
}

/**
 * Normalize a single raw Messenger messaging event into an InboundMessage.
 * Returns null when the event has no usable content (no text, no image, no
 * postback) so the controller can skip it without noise.
 */
export function normalizeEvent(event: RawMessagingEvent): InboundMessage | null {
  const text = extractText(event);
  const imageUrl = extractImageUrl(event);
  const referral = extractReferral(event);
  const mid = event.message?.mid;

  // Skip events that carry no usable signal at all (e.g. delivery/read receipts
  // that sneak through despite not being subscribed).
  if (!text && !imageUrl) return null;

  return {
    psid: event.sender.id,
    text,
    ...(imageUrl ? { imageUrl } : {}),
    ...(mid ? { mid } : {}),
    timestamp: event.timestamp,
    ...(referral && Object.keys(referral).length > 0 ? { referral } : {}),
  };
}
