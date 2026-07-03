/**
 * The structured schema the transcription model must populate for a customer
 * voice note. Unlike the vision schema there are no catalog-sourced enums —
 * the shape is static, so it is built once at module load.
 *
 * `transcript` is the verbatim dialectal Arabic as spoken; `normalizedText` is
 * a light "what she means" rendering the model fills only when the speech is
 * broken/mixed enough that the verbatim form would mislead the sales agent.
 */

import { z } from 'zod';

export const transcriptionOutputSchema = z.object({
  /** Verbatim transcript in Arabic script, dialect preserved. */
  transcript: z.string(),
  /** Simplified/MSA-ish rendering when the speech is broken; null otherwise. */
  normalizedText: z.string().nullable(),
  /** Detected language/dialect tag, e.g. 'ar-JO', 'ar', 'mixed'; null if unknown. */
  language: z.string().nullable(),
  /** Model's honest confidence in the transcript, 0..1. */
  confidence: z.number().min(0).max(1),
  /** False when the audio is noise/empty/non-speech or genuinely undecipherable. */
  intelligible: z.boolean(),
  /** Model's own short note explaining a not-intelligible result; null otherwise. */
  reason: z.string().nullable(),
});

export type TranscriptionOutput = z.infer<typeof transcriptionOutputSchema>;
