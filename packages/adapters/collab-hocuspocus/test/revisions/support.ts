import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { createCollabLog } from '../../src/events.js';
import { revisionReport } from '../../src/extensions/revisions.js';
import { createRevisionScheduler } from '../../src/revisions/scheduler.js';
import type { Timers } from '../../src/revisions/scheduler.js';

/** Timers that run only when the test moves the shared clock: no real waiting. */
export class FakeTimers implements Timers {
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();
  private next = 1;

  constructor(private readonly clock: FakeClock) {}

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.next;
    this.next += 1;
    this.scheduled.set(handle, { at: this.clock.now() + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }

  /** How many timers are waiting. */
  get pending(): number {
    return this.scheduled.size;
  }

  /** Moves the clock and runs what came due, in time order. */
  advance(ms: number): void {
    const target = this.clock.now() + ms;
    for (;;) {
      const due = [...this.scheduled].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.scheduled.delete(due[0]);
      this.clock.set(Math.max(this.clock.now(), due[1].at));
      due[1].callback();
    }
    this.clock.set(target);
  }
}

export const ANA = '00000000-0000-4000-8000-0000000000a1';
export const BOB = '00000000-0000-4000-8000-0000000000b2';
export const PAGE = '00000000-0000-4000-8000-0000000000c1';
export const MINUTE = 60_000;

export function build(start = 1_700_000_000_000) {
  const clock = new FakeClock(start);
  const timers = new FakeTimers(clock);
  const logger = new FakeLogger();
  const repo = new FakeRevisionRepo();
  const scheduler = createRevisionScheduler({ repo, clock, report: revisionReport(createCollabLog(logger)), timers });
  const events = (name: string) => logger.entries.filter((e) => e.event === name);
  return { clock, timers, logger, repo, scheduler, events };
}
