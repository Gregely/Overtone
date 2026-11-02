import type { Clock } from '../platform/types.js';

/** Deterministic clock: sleep() advances time instantly; schedule() runs only when you call tick(). */
export function fakeClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void; tick(ms: number): void; sleeps: number[]; pending(): number } {
  let now = start;
  const sleeps: number[] = [];
  let timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    sleeps,
    async sleep(ms, signal) {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
    },
    schedule(ms, fn) {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    advance(ms) {
      now += ms;
    },
    tick(ms) {
      now += ms;
      const due = timers.filter((t) => !t.cancelled && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  };
}
