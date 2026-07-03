/**
 * Zod schemas and OpenAPI DTOs for the conversations admin control surface
 * (WS5 + WS6 — AIA-34). All schemas use `.strict()` to reject unknown keys.
 *
 * The schemas are shared: the HTTP controller uses them via ZodValidationPipe,
 * and the AI agent tools can import them directly for identical validation.
 */

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AI_STATES } from '../entities/conversation.entity';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Admin-list sort keys: last-message activity or thread creation time. */
export const CONVERSATION_SORT_KEYS = ['activity', 'created'] as const;

/** Query params for GET /admin/conversations. */
export const listConversationsQuerySchema = z
  .object({
    state: z.enum(AI_STATES).optional(),
    assignedTo: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    // Sort key (default: created) + direction (default: desc). Pinned threads
    // always come first regardless of sort.
    sort: z.enum(CONVERSATION_SORT_KEYS).optional(),
    orderBy: z.enum(['asc', 'desc']).optional(),
  })
  .strict();
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;

/** Body for POST /admin/conversations/:id/pause. */
export const pauseConversationSchema = z
  .object({
    reason: z.string().min(1).optional(),
    durationMinutes: z.coerce.number().int().positive().max(1440).optional(),
  })
  .strict();
export type PauseConversationInput = z.infer<typeof pauseConversationSchema>;

/** Body for POST /admin/conversations/:id/resume. */
export const resumeConversationSchema = z
  .object({
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ResumeConversationInput = z.infer<typeof resumeConversationSchema>;

/** Body for PATCH /admin/conversations/:id/assignment. */
export const assignConversationSchema = z
  .object({
    assignedTo: z.string().min(1).nullable(),
  })
  .strict();
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;

/** Body for POST /admin/conversations/:id/handoff. */
export const handoffConversationSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();
export type HandoffConversationInput = z.infer<
  typeof handoffConversationSchema
>;

/** Body for POST /admin/conversations/:id/messages. */
export const humanMessageSchema = z
  .object({
    text: z.string().min(1),
  })
  .strict();
export type HumanMessageInput = z.infer<typeof humanMessageSchema>;

/** Body for PATCH /admin/conversations/:id/pin. */
export const pinConversationSchema = z
  .object({
    pinned: z.boolean(),
  })
  .strict();
export type PinConversationInput = z.infer<typeof pinConversationSchema>;

// ---------------------------------------------------------------------------
// OpenAPI DTO classes (nestjs-zod createZodDto for Scalar docs integration)
// ---------------------------------------------------------------------------

/**
 * One item in the GET /admin/conversations list.
 * `escalated` = handoffReason is non-null (the conversation was escalated by
 * the agent). `unreadCount` is deferred (no read-tracking yet) — always 0.
 */
export const conversationListItemSchema = z.object({
  id: z.string().uuid(),
  customer: z.string(),
  aiState: z.enum(AI_STATES),
  assignedTo: z.string().nullable(),
  handoffReason: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unreadCount: z.number().int(),
  escalated: z.boolean(),
  /** Pinned in the admin inbox — pinned threads sort first server-side. */
  pinned: z.boolean(),
});
export class ConversationListItemDto extends createZodDto(
  conversationListItemSchema,
) {}

/** A paginated list of ConversationListItemDto. */
export const conversationListResponseSchema = z.object({
  items: z.array(conversationListItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export class ConversationListResponseDto extends createZodDto(
  conversationListResponseSchema,
) {}

/**
 * A single message within a conversation thread — used in ConversationThreadDto.
 */
export const threadMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.string(),
  content: z.string().nullable(),
  imageUrl: z.string().nullable(),
  // Free-form extraction metadata (vision/eval/audio); audio carries the
  // voice-note url + transcript details for the thread UI.
  attributes: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

/**
 * GET /admin/conversations/:id — the conversation header plus its full message list.
 */
export const conversationThreadSchema = z.object({
  conversation: z.object({
    id: z.string().uuid(),
    psid: z.string(),
    aiState: z.enum(AI_STATES),
    assignedTo: z.string().nullable(),
    handoffReason: z.string().nullable(),
    humanSummary: z.string().nullable(),
    pausedUntil: z.string().nullable(),
    createdAt: z.string(),
    /** Pinned in the admin inbox (see PATCH :id/pin). */
    pinned: z.boolean(),
  }),
  messages: z.array(threadMessageSchema),
});
export class ConversationThreadDto extends createZodDto(
  conversationThreadSchema,
) {}
