/**
 * Zod schemas for the Meta Messenger Platform webhook:
 *  - messengerVerifyQuerySchema  — GET /webhook/messenger (hub verification)
 *  - messengerWebhookBodySchema  — POST /webhook/messenger (inbound events)
 *
 * Security: this is an untrusted public webhook. All user-controlled string
 * fields are bounded by .max() caps exactly like manychat-webhook.dto.ts does:
 * generous enough to never reject real traffic, tight enough to stop a payload
 * amplification / DoS via the LLM prompt or DB.
 *
 * Meta adds new fields over time, so we use .passthrough() (not .strict()) at
 * every level we don't fully control. We validate only what we actually read.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// GET /webhook/messenger — hub verification
// ---------------------------------------------------------------------------

export const messengerVerifyQuerySchema = z.object({
  'hub.mode': z.string().max(64),
  'hub.verify_token': z.string().max(512),
  'hub.challenge': z.string().max(256),
});

export type MessengerVerifyQuery = z.infer<typeof messengerVerifyQuerySchema>;

// ---------------------------------------------------------------------------
// POST /webhook/messenger — inbound event body
// ---------------------------------------------------------------------------

/** Ads context data from a Click-to-Messenger ad referral. */
const adsContextDataSchema = z
  .object({
    ad_title: z.string().max(512).optional(),
    photo_url: z.string().max(2048).optional(),
    video_url: z.string().max(2048).optional(),
    post_id: z.string().max(64).optional(),
    product_id: z.string().max(64).optional(),
    flow_id: z.string().max(64).optional(),
  })
  .passthrough();

/** Referral object (top-level event, message.referral, or postback.referral). */
const referralSchema = z
  .object({
    ref: z.string().max(512).optional(),
    ad_id: z.string().max(64).optional(),
    source: z.string().max(64).optional(),
    type: z.string().max(64).optional(),
    ads_context_data: adsContextDataSchema.optional(),
  })
  .passthrough();

/** A single attachment in a message. */
const attachmentSchema = z
  .object({
    type: z.string().max(64),
    payload: z
      .object({
        url: z.string().max(2048).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Quick reply selected by the customer. */
const quickReplySchema = z
  .object({
    content_type: z.string().max(64),
    payload: z.string().max(1000).optional(),
    title: z.string().max(256).optional(),
  })
  .passthrough();

/** The message object inside a messaging event. */
const messageSchema = z
  .object({
    mid: z.string().max(256),
    text: z.string().max(4000).optional(),
    attachments: z.array(attachmentSchema).optional(),
    quick_reply: quickReplySchema.optional(),
    referral: referralSchema.optional(),
  })
  .passthrough();

/** Postback from a button tap or get-started. */
const postbackSchema = z
  .object({
    title: z.string().max(256).optional(),
    payload: z.string().max(1000).optional(),
    referral: referralSchema.optional(),
  })
  .passthrough();

/** A single messaging event inside an entry. */
const messagingEventSchema = z
  .object({
    sender: z.object({ id: z.string().max(64) }).passthrough(),
    recipient: z.object({ id: z.string().max(64) }).passthrough(),
    timestamp: z.number().int(),
    message: messageSchema.optional(),
    postback: postbackSchema.optional(),
    referral: referralSchema.optional(),
  })
  .passthrough();

/** One entry (one page) in the webhook body. */
const entrySchema = z
  .object({
    id: z.string().max(64),
    time: z.number().int(),
    // Cap at 100: Meta batches are small; an uncapped array could fan out to
    // thousands of agent/LLM calls from a single oversized request (DoS).
    messaging: z.array(messagingEventSchema).max(100),
  })
  .passthrough();

/** The full POST body from Meta. */
export const messengerWebhookBodySchema = z
  .object({
    object: z.string().max(64),
    // Cap at 50: Meta sends one entry per page subscription; a forged body
    // with many entries would multiply the per-entry messaging fan-out.
    entry: z.array(entrySchema).max(50),
  })
  .passthrough();

export type MessengerWebhookBody = z.infer<typeof messengerWebhookBodySchema>;
