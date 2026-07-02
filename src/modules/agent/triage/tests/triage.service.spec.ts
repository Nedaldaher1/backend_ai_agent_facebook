import { TriageService } from '../triage.service';
import type { ConfigService } from '@nestjs/config';

function makeService(
  overrides: Record<string, string | undefined> = { TRIAGE_ENABLED: 'true' },
): TriageService {
  const config = {
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
  return new TriageService(config);
}

describe('TriageService.match', () => {
  const service = makeService();

  it.each([
    'مرحبا',
    'مرحبتين',
    'هلا',
    'هلا والله',
    'أهلين',
    'اهلا وسهلا',
    'السلام عليكم',
    'السلام عليكم ورحمة الله وبركاته',
    'صباح الخير',
    'مساء النور',
    'هاي',
    'مرحبا!!',
    ' مرحبا ',
  ])('classifies %j as greeting', (text) => {
    expect(service.match(text)).toBe('greeting');
  });

  it.each([
    'شكرا',
    'شكرا كتير',
    'يسلمو',
    'يسلمو ايديكي',
    'تسلمي',
    'مشكورة',
    'يعطيكي العافية',
    'الله يعطيك العافية',
    'Thanks',
    'thank you',
    'شكراً',
  ])('classifies %j as thanks', (text) => {
    expect(service.match(text)).toBe('thanks');
  });

  it.each([
    // Real intents must NEVER be triaged.
    'بدي عباية',
    'مرحبا بدي عباية حمرا',
    'شكرا بس بدي أغير اللون',
    'قديش السعر',
    // Bare acks are deliberately excluded — often in-flow answers.
    'اه',
    'تمام',
    'اوك',
    'ماشي',
    'طيب',
    // Numbers / phones (order flow inputs).
    '0791234567',
    // Empty.
    '',
    '   ',
  ])('does NOT triage %j', (text) => {
    expect(service.match(text)).toBeNull();
  });

  it('never matches when longer than TRIAGE_MAX_CHARS', () => {
    const tight = makeService({
      TRIAGE_ENABLED: 'true',
      TRIAGE_MAX_CHARS: '4',
    });
    expect(tight.match('هلا')).toBe('greeting');
    expect(tight.match('السلام عليكم')).toBeNull();
  });

  it('is disabled unless TRIAGE_ENABLED is exactly "true"', () => {
    expect(makeService({}).match('مرحبا')).toBeNull();
    expect(makeService({ TRIAGE_ENABLED: 'yes' }).match('مرحبا')).toBeNull();
    expect(makeService({ TRIAGE_ENABLED: 'true' }).enabled).toBe(true);
  });
});

describe('TriageService.reply', () => {
  it('returns the model text and normalized usage', async () => {
    const service = makeService();
    // Reach into the lazy agent slot with a stub — the real Agent would call
    // the network.
    (service as unknown as { agent: unknown }).agent = {
      generate: jest.fn().mockResolvedValue({
        text: 'أهلين فيكي، كيف بقدر أساعدك؟',
        usage: { inputTokens: 90, outputTokens: 12, totalTokens: 102 },
      }),
    };

    const out = await service.reply('greeting', 'مرحبا');

    expect(out.reply).toBe('أهلين فيكي، كيف بقدر أساعدك؟');
    expect(out.usage).toEqual({
      inputTokens: 90,
      cachedInputTokens: undefined,
      outputTokens: 12,
      totalTokens: 102,
    });
  });

  it('falls back to the fixed line when the model errors', async () => {
    const service = makeService();
    (service as unknown as { agent: unknown }).agent = {
      generate: jest.fn().mockRejectedValue(new Error('429')),
    };

    const out = await service.reply('thanks', 'شكرا');

    expect(out.reply).toContain('تكرمي');
    expect(out.usage).toBeUndefined();
  });

  it('falls back when the model returns empty text', async () => {
    const service = makeService();
    (service as unknown as { agent: unknown }).agent = {
      generate: jest.fn().mockResolvedValue({ text: '   ' }),
    };

    const out = await service.reply('greeting', 'هلا');

    expect(out.reply).toContain('أهلين');
  });
});
