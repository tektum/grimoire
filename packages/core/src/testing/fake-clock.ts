import type { Clock } from '../ports/clock.js';

/** Deterministic clock: time moves only when the test says so. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance requires a non-negative finite number');
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
