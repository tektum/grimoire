import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { createJobRunner } from '../../src/jobs/runner.js';

class RecordingQueue implements JobQueue {
  readonly worked: string[] = [];
  readonly scheduled: string[] = [];
  stopped: { graceMs: number }[] = [];
  inFlight = 0;
  ensureQueue(): Promise<void> { return Promise.resolve(); }
  enqueue(): Promise<string | null> { return Promise.resolve('id'); }
  isLive(): Promise<boolean> { return Promise.resolve(false); }
  work(name: string): Promise<void> { this.worked.push(name); return Promise.resolve(); }
  schedule(name: string): Promise<void> { this.scheduled.push(name); return Promise.resolve(); }
  stop(o: { graceMs: number }): Promise<{ inFlight: number }> { this.stopped.push(o); return Promise.resolve({ inFlight: this.inFlight }); }
}

afterEach(() => { vi.useRealTimers(); });

const make = (queue: RecordingQueue, errors: Error[] = []) => {
  const logger = new FakeLogger();
  const config = makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' }, jobs: { stopGraceMs: 4321 } });
  const runner = createJobRunner({ config, log: createEventLog(logger), make: () => Promise.resolve(queue), onError: (e) => { errors.push(e); } });
  return { runner, logger };
};

describe('the job runner', () => {
  it('registers a handler for each job of the registry when it starts, and starts once', async () => {
    const queue = new RecordingQueue();
    const { runner } = make(queue);
    await runner.start();
    await runner.start();
    expect(queue.worked).toEqual(['import', 'import-sweep', 'import-cleanup']);
  });

  it('does not schedule anything yet: whether the runtime role may run the cron loop is settled by M7-T02', async () => {
    const queue = new RecordingQueue();
    await make(queue).runner.start();
    expect(queue.scheduled).toEqual([]);
  });

  it('stops with the grace of the settings and logs how many jobs were still running', async () => {
    const queue = new RecordingQueue();
    queue.inFlight = 2;
    const { runner, logger } = make(queue);
    await runner.start();
    await runner.hook.run();
    expect(queue.stopped).toEqual([{ graceMs: 4321 }]);
    expect(logger.entries.find((e) => e.event === 'jobs.stopped')?.fields).toEqual({ inFlight: 2 });
  });

  it('stops cleanly when it never started', async () => {
    const queue = new RecordingQueue();
    const { runner, logger } = make(queue);
    await runner.hook.run();
    expect(queue.stopped).toEqual([]);
    expect(logger.entries.some((e) => e.event === 'jobs.stopped')).toBe(false);
  });

  it('does not fail the server when the queue cannot start (a database not migrated yet is a state the server runs in): it logs and tries again later', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    let attempts = 0;
    const logger = new FakeLogger();
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(logger), make: () => (++attempts === 1 ? Promise.reject(new Error('no schema')) : Promise.resolve(queue)) });
    await expect(runner.start()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(queue.worked).toEqual([]);
    expect(logger.entries.filter((e) => e.event === 'jobs.failed')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(2);
    expect(queue.worked).toEqual(['import', 'import-sweep', 'import-cleanup']);
    await runner.hook.run();
  });

  it('stops trying when it is stopped', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => { attempts++; return Promise.reject(new Error('no schema')); } });
    await runner.start();
    await runner.hook.run();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
  });
});
