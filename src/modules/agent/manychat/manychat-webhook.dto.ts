/**
 * Shared inbound DTO for the ManyChat webhook.
 *
 * ManyChat's External Request POSTs a body we configure in the ManyChat flow.
 * The field names below are our chosen names; in the ManyChat UI the "Field
 * Mapping" section maps each ManyChat Full-Contact-Data field to the key we
 * pick. Mapping table:
 *
 *  Our field         ← ManyChat Full-Contact-Data source
 *  ─────────────────────────────────────────────────────
 *  contactId         ← {{contact.id}}          (numeric subscriber id, stable)
 *  text              ← {{last_input_text}}      (the message the subscriber sent)
 *  lastImageUrl      ← a Custom User Field you populate via a User Input step that
 *                       captures the image as TEXT — ManyChat has NO system field
 *                       for the last attachment URL. Empty '' → undefined. Optional.
 *  adRef             ← a Custom User Field you populate via the Messenger Ref URL /
 *                       Facebook Ads trigger "save payload" — NO system {{ref}}
 *                       field exists; present only on ad/ref entry points. Optional.
 *  name              ← {{contact.name}}         (Facebook display name; optional)
 *  channel           ← hardcoded in the flow   ('messenger' | 'whatsapp'; defaults
 *                       to messenger if omitted)
 *  messageId         ← {{last_sent_message_id}} or similar; optional idempotency key
 *                       (ManyChat has no stable per-message id on all entry points)
 *
 * This schema is shared between ManyChatWebhookController (the real ManyChat
 * surface) and AgentController (the TEMP /agent/message dev surface) so field
 * definitions live in exactly one place.
 */

import { z } from 'zod';

// `.max(...)` caps bound the UNTRUSTED webhook payload (reachable from the public
// webhook). They are deliberately generous — well above any legitimate value —
// so they never reject real traffic, but they stop an oversized `text` from being
// amplified into LLM prompt tokens + a stored row on every turn (cost/DoS).
export const manyChatWebhookSchema = z.object({
  /** ManyChat subscriber id ({{contact.id}}) — stable across sessions. */
  contactId: z.string().min(1).max(64),
  /** The message text the subscriber sent ({{last_input_text}}). */
  text: z.string().min(1).max(4000),
  /**
   * URL of an image the subscriber attached (optional).
   *
   * Sourced from a Custom User Field populated in the flow (ManyChat has no system
   * field for the last attachment URL — see docs/manychat-quick-start.md). ManyChat
   * substitutes an EMPTY string for an unset custom field, so we coerce '' →
   * undefined here: a text-only turn must NOT trip the `.url()` check. That 400
   * fires in the validation pipe, BEFORE the controller's never-5xx fallback, so
   * the subscriber would otherwise get nothing on every imageless message.
   */
  lastImageUrl: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().max(2048).optional(),
  ),
  /**
   * Ad ref slug from {{ref}} — present only on ref-ad / comment-reply entry
   * points, absent on direct messages.
   */
  adRef: z.string().max(512).optional(),
  /** Facebook display name from {{contact.name}} — best-effort seed for working memory. */
  name: z.string().max(256).optional(),
  /**
   * Inbound channel — sets order.source server-side; ManyChat hardcodes this
   * in the flow body. Defaults to 'messenger' when omitted.
   */
  channel: z.enum(['messenger', 'whatsapp']).optional(),
  /**
   * Provider message id for idempotency. ManyChat has no guaranteed per-message
   * id on all entry points; when absent AgentService falls back to a
   * content + 10-second-window hash. Map from {{last_sent_message_id}} or a
   * custom message-id field if your flow exposes one.
   */
  messageId: z.string().max(256).optional(),
});

export type ManyChatWebhookDto = z.infer<typeof manyChatWebhookSchema>;
