import { transcriptionOutputSchema } from '../transcription.schema';

const VALID = {
  transcript: 'بدي عباية سوداء مقاس 54',
  normalizedText: null,
  language: 'ar-JO',
  confidence: 0.9,
  intelligible: true,
  reason: null,
};

describe('transcriptionOutputSchema', () => {
  it('accepts a full valid output', () => {
    expect(transcriptionOutputSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts a not-intelligible output with a reason', () => {
    const res = transcriptionOutputSchema.safeParse({
      ...VALID,
      transcript: '',
      confidence: 0.1,
      intelligible: false,
      reason: 'ضجيج فقط',
    });
    expect(res.success).toBe(true);
  });

  it('rejects a confidence outside [0, 1]', () => {
    expect(
      transcriptionOutputSchema.safeParse({ ...VALID, confidence: 1.4 })
        .success,
    ).toBe(false);
    expect(
      transcriptionOutputSchema.safeParse({ ...VALID, confidence: -0.1 })
        .success,
    ).toBe(false);
  });

  it('rejects a missing transcript / intelligible flag', () => {
    const noTranscript: Record<string, unknown> = { ...VALID };
    delete noTranscript.transcript;
    expect(transcriptionOutputSchema.safeParse(noTranscript).success).toBe(
      false,
    );
    const noFlag: Record<string, unknown> = { ...VALID };
    delete noFlag.intelligible;
    expect(transcriptionOutputSchema.safeParse(noFlag).success).toBe(false);
  });
});
