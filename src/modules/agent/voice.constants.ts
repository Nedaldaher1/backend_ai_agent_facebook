/**
 * Voice-message (Messenger audio attachment) constants: the transcript markers
 * stored in `messages.content`, the customer-facing degrade replies, and the
 * deterministic escalation policy.
 *
 * Brand voice: NO emoji. Replies stay in the Jordanian persona.
 */

/** Prefix stored before a successful transcript in `messages.content`. */
export const VOICE_NOTE_MARKER = '[رسالة صوتية]';

/** Stored in `messages.content` when the voice note could not be transcribed. */
export const VOICE_FAILED_MARKER = '[رسالة صوتية — تعذّر تفريغها]';

/** First-failure reply: ask the customer to resend or type instead. */
export const VOICE_RETRY_REPLY =
  'سامحيني، ما قدرت أسمع رسالتك الصوتية منيح. ممكن تعيديها أو تكتبيلي طلبك كتابة؟';

/** Reply when the recording exceeds the duration/size caps. */
export const VOICE_TOO_LONG_REPLY =
  'الرسالة الصوتية طويلة شوي عليّ. ممكن تبعتيلي المهم مكتوب أو رسالة أقصر؟';

/** Machine-readable prefix for `conversations.handoff_reason` on voice escalation. */
export const VOICE_ESCALATE_REASON = 'voice_not_understood';

/**
 * Consecutive unusable voice-only turns before the conversation is escalated
 * to a human (the counter lives in `conversations.state.voiceFailCount` and
 * resets on any successful turn or on escalation).
 */
export const VOICE_FAIL_ESCALATE_THRESHOLD = 2;
