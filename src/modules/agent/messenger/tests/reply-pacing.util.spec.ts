import { splitIntoBubbles, typingDelayMs, sleep } from '../reply-pacing.util';

describe('splitIntoBubbles', () => {
  it('splits on blank lines into trimmed bubbles', () => {
    expect(splitIntoBubbles('أهلاً\n\nكيف أساعدك؟', 4)).toEqual([
      'أهلاً',
      'كيف أساعدك؟',
    ]);
  });

  it('treats one or more blank lines (with stray whitespace) as a single break', () => {
    expect(splitIntoBubbles('a\n\n\n  \n b \n\nc', 5)).toEqual(['a', 'b', 'c']);
  });

  it('keeps single newlines inside a bubble', () => {
    expect(splitIntoBubbles('line1\nline2\n\nnext', 4)).toEqual([
      'line1\nline2',
      'next',
    ]);
  });

  it('returns one bubble when there are no blank lines', () => {
    expect(splitIntoBubbles('just one paragraph', 4)).toEqual([
      'just one paragraph',
    ]);
  });

  it('returns [] for empty / whitespace-only text', () => {
    expect(splitIntoBubbles('', 4)).toEqual([]);
    expect(splitIntoBubbles('   \n\n  ', 4)).toEqual([]);
  });

  it('folds overflow paragraphs into the last bubble at maxBubbles', () => {
    // 5 paragraphs, cap 3 → [p1, p2, "p3\n\np4\n\np5"]
    const text = 'p1\n\np2\n\np3\n\np4\n\np5';
    expect(splitIntoBubbles(text, 3)).toEqual(['p1', 'p2', 'p3\n\np4\n\np5']);
  });

  it('clamps maxBubbles < 1 to a single merged bubble', () => {
    expect(splitIntoBubbles('a\n\nb', 0)).toEqual(['a\n\nb']);
  });
});

describe('typingDelayMs', () => {
  const opts = { perChar: 45, min: 700, max: 2500 };

  it('is proportional to length within the clamp', () => {
    expect(typingDelayMs(30, opts)).toBe(1350); // 30 × 45
  });

  it('clamps to the minimum (e.g. images, length 0)', () => {
    expect(typingDelayMs(0, opts)).toBe(700);
    expect(typingDelayMs(5, opts)).toBe(700); // 225 < 700 → 700
  });

  it('clamps to the maximum for long text', () => {
    expect(typingDelayMs(1000, opts)).toBe(2500); // 45000 → 2500
  });
});

describe('sleep', () => {
  it('resolves immediately for ms <= 0 (no timer scheduled)', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-5)).resolves.toBeUndefined();
  });

  it('resolves only after the delay (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      let done = false;
      const p = sleep(500).then(() => {
        done = true;
      });
      expect(done).toBe(false);
      jest.advanceTimersByTime(500);
      await p;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
