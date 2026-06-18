import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Request/response contracts for POST /agent/message.
 *
 * The zod schema is the single source of truth: `ZodValidationPipe` validates
 * the HTTP body against `incomingMessageSchema` at the route, and the matching
 * `*Dto` (nestjs-zod `createZodDto`) documents the same shape in the Scalar docs
 * (mirrors the auth DTO pattern).
 *
 * Fields mirror the ManyChat External Request payload exactly — no defaults, so
 * integration tests and the eventual ManyChat block must supply every required
 * field explicitly.
 *
 *  contactId    — ManyChat contact_id (stable subscriber id, stored as `psid`).
 *  text         — Customer message text (required, non-empty).
 *  lastImageUrl — Customer-sent image URL (optional; vision processing deferred).
 *  adRef        — Self-controlled ref slug from ManyChat (optional).
 *  name         — Facebook profile name from ManyChat (optional best-effort).
 */
export const incomingMessageSchema = z.object({
  contactId: z.string().min(1),
  text: z.string().min(1),
  lastImageUrl: z.string().url().optional(),
  adRef: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Agent reply shape. `price` is a STRING (JOD notation) to honour the
 * money-as-string rule (CLAUDE.md §3 — never use float for prices). `products`
 * is omitted when the turn surfaced no catalog matches.
 */
export const agentReplySchema = z.object({
  reply: z.string(),
  products: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        price: z.string(),
      }),
    )
    .optional(),
});

export class IncomingMessageDto extends createZodDto(incomingMessageSchema) {}
export class AgentReplyDto extends createZodDto(agentReplySchema) {}
