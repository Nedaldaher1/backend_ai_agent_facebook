/** Customer-facing line shown when the conversation is handed to a human.
 *  Used both by escalate_to_human (the turn that escalates) and by the
 *  handleMessage pause-gate (every subsequent turn while paused). */
export const HANDOFF_REPLY =
  'فريق الدعم رح يتواصل معك مباشرة لحل الموضوع — شكراً لصبرك.';

/** Machine-readable prefix for conversations.handoff_reason when a hard AI
 *  failure (generate() threw, or empty reply after the retry policy) forces
 *  the escalation — mirrors VOICE_ESCALATE_REASON in voice.constants.ts. */
export const AI_FAILURE_ESCALATE_REASON = 'ai_failure';
