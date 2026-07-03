/**
 * DebounceService — a generic, in-memory, per-key debounce buffer.
 *
 * Customers often send a burst of quick messages ("بدي عباية" … "حمراء" … "مقاس
 * L") that should be answered as ONE turn. This buffers items under a key (the
 * customer id), resets a short window on each new item, and flushes once — with
 * a hard cap so a continuous typer still gets answered.
 *
 * In-process and single-instance by design (matches the current deployment); a
 * Redis/BullMQ-backed buffer would be needed to debounce across multiple app
 * processes. Used by the Messenger webhook controller, which ACKs 200 immediately
 * and delivers the agent reply asynchronously after the debounce window closes.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type FlushFn = (items: unknown[]) => void | Promise<void>;

interface Batch {
  items: unknown[];
  firstAt: number;
  timer: NodeJS.Timeout | undefined;
  flush: FlushFn;
}

@Injectable()
export class DebounceService implements OnModuleDestroy {
  private readonly logger = new Logger(DebounceService.name);
  private readonly windowMs: number;
  private readonly maxMs: number;
  private readonly buffers = new Map<string, Batch>();

  constructor(config: ConfigService) {
    this.windowMs = Number(config.get<string>('DEBOUNCE_WINDOW_MS') ?? '2000');
    this.maxMs = Number(config.get<string>('DEBOUNCE_MAX_MS') ?? '8000');
  }

  /**
   * Append `item` to the buffer for `key` and (re)arm the flush timer. The flush
   * fires after `windowMs` of quiet, but never later than `maxMs` after the first
   * item in the batch. `flush` receives every buffered item in arrival order.
   */
  enqueue<T>(
    key: string,
    item: T,
    flush: (items: T[]) => void | Promise<void>,
  ): void {
    let batch = this.buffers.get(key);
    if (!batch) {
      batch = {
        items: [],
        firstAt: Date.now(),
        timer: undefined,
        flush: flush,
      };
      this.buffers.set(key, batch);
    }
    batch.items.push(item);
    // Keep the latest handler (closures capture the latest request context).
    batch.flush = flush;

    if (batch.timer) clearTimeout(batch.timer);
    const elapsed = Date.now() - batch.firstAt;
    const delay = Math.max(0, Math.min(this.windowMs, this.maxMs - elapsed));
    batch.timer = setTimeout(() => this.fire(key), delay);
  }

  /** Flush and clear the batch for `key`. */
  private fire(key: string): void {
    const batch = this.buffers.get(key);
    if (!batch) return;
    this.buffers.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    // Invoke the flush synchronously when the timer fires; only its async
    // completion is deferred. Best-effort: a delivery failure must never crash
    // the timer callback (it would surface as an unhandled rejection otherwise).
    try {
      const result = batch.flush(batch.items);
      if (result instanceof Promise) {
        result.catch((err: unknown) =>
          this.logger.warn(
            `debounce flush failed for key ${key}: ${String(err)}`,
          ),
        );
      }
    } catch (err) {
      this.logger.warn(`debounce flush failed for key ${key}: ${String(err)}`);
    }
  }

  /** Clear all pending timers on shutdown so nothing fires after teardown. */
  onModuleDestroy(): void {
    for (const batch of this.buffers.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.buffers.clear();
  }
}
