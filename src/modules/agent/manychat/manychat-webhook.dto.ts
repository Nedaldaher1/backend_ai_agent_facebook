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
 *  lastImageUrl      ← {{last_input_attachment_url}} or a custom attachment field
 *                       (URL of the last image/file the subscriber sent; optional)
 *  adRef             ← {{ref}}                 (ad ref slug from the entry point;
 *                       only present when the contact entered via a Comment/Ref ad)
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

export const manyChatWebhookSchema = z.object({
  /** ManyChat subscriber id ({{contact.id}}) — stable across sessions. */
  contactId: z.string().min(1),
  /** The message text the subscriber sent ({{last_input_text}}). */
  text: z.string().min(1),
  /**
   * URL of an image the subscriber attached (optional).
   * Maps from the attachment URL field configured in the ManyChat flow.
   */
  lastImageUrl: z.string().url().optional(),
  /**
   * Ad ref slug from {{ref}} — present only on ref-ad / comment-reply entry
   * points, absent on direct messages.
   */
  adRef: z.string().optional(),
  /** Facebook display name from {{contact.name}} — best-effort seed for working memory. */
  name: z.string().optional(),
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
  messageId: z.string().optional(),
});

export type ManyChatWebhookDto = z.infer<typeof manyChatWebhookSchema>;
