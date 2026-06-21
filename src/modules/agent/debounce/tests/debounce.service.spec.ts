import { DebounceService } from '../debounce.service';
import type { ConfigService } from '@nestjs/config';

function makeService(windowMs = 2000, maxMs = 8000): DebounceService {
  const config = {
    get: (k: string) =>
      k === 'DEBOUNCE_WINDOW_MS'
        ? String(windowMs)
        : k === 'DEBOUNCE_MAX_MS'
          ? String(maxMs)
          : undefined,
  } as unknown as ConfigService;
  return new DebounceService(config);
}

describe('DebounceService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('flushes a single item once after the window', () => {
    const svc = makeService();
    const flush = jest.fn();

    svc.enqueue('k', 'a', flush);
    expect(flush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a']);
  });

  it('coalesces rapid items into one flush with all items', () => {
    const svc = makeService();
    const flush = jest.fn();

    svc.enqueue('k', 'a', flush);
    jest.advanceTimersByTime(1000);
    svc.enqueue('k', 'b', flush); // resets the 2s window
    jest.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled(); // only 1s since 'b'

    jest.advanceTimersByTime(1000); // 2s since 'b'
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['a', 'b']);
  });

  it('fires by the hard cap even under continuous input', () => {
    const svc = makeService(2000, 5000);
    const flush = jest.fn();

    // enqueue every 1s: the 2s window keeps resetting, but the 5s cap forces a flush.
    for (let i = 0; i < 6; i++) {
      svc.enqueue('k', i, flush);
      jest.advanceTimersByTime(1000);
    }

    expect(flush).toHaveBeenCalledTimes(1);
    const items = flush.mock.calls[0][0] as number[];
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps separate keys independent', () => {
    const svc = makeService();
    const fa = jest.fn();
    const fb = jest.fn();

    svc.enqueue('a', 1, fa);
    svc.enqueue('b', 2, fb);
    jest.advanceTimersByTime(2000);

    expect(fa).toHaveBeenCalledWith([1]);
    expect(fb).toHaveBeenCalledWith([2]);
  });

  it('clears pending timers on shutdown (no flush after destroy)', () => {
    const svc = makeService();
    const flush = jest.fn();

    svc.enqueue('k', 'a', flush);
    svc.onModuleDestroy();
    jest.advanceTimersByTime(5000);

    expect(flush).not.toHaveBeenCalled();
  });
});
