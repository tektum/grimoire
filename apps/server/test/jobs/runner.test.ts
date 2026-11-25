import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { createJobRunner, MAX_START_ATTEMPTS, START_RETRY_MS, START_STOP_WAIT_MS } from '../../src/jobs/runner.js';

class RecordingQueue implements JobQueue {
  readonly worked: string[] = [];
  readonly scheduled: string[] = [];
  stopped: { graceMs: number }[] = [];
  inFlight = 0;
  ensureQueue(): Promise<void> { return Promise.resolve(); }
  enqueue(): Promise<string | null> { return Promise.resolve('id'); }
  isLive(): Promise<boolean> { return Promise.resolve(false); }
  failWork = false;
  work(name: string): Promise<void> { if (this.failWork) return Promise.reject(new Error('no queue')); this.worked.push(name); return Promise.resolve(); }
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

  it('stops a queue that started but could not register its handlers (with no grace), before it tries again, so no attempt leaves a queue behind', async () => {
    vi.useFakeTimers();
    const made: RecordingQueue[] = [];
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => { const q = new RecordingQueue(); q.failWork = made.length === 0; made.push(q); return Promise.resolve(q); } });
    await runner.start();
    expect(made).toHaveLength(1);
    expect(made[0]?.stopped).toEqual([{ graceMs: 0 }]);
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);
    expect(made).toHaveLength(2);
    expect(made[1]?.worked).toEqual(['import', 'import-sweep', 'import-cleanup']);
    expect(made[1]?.stopped).toEqual([]);
    await runner.hook.run();
    expect(made[1]?.stopped).toEqual([{ graceMs: 15_000 }]);
  });

  it('a stop that comes while the queue is still starting waits for it, registers no handler, and stops that queue', async () => {
    const queue = new RecordingQueue();
    let release: (q: RecordingQueue) => void = () => undefined;
    const pending = new Promise<RecordingQueue>((resolve) => { release = resolve; });
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => pending });
    const starting = runner.start();
    let hookDone = false;
    const stopping = runner.hook.run().then(() => { hookDone = true; });
    await Promise.resolve();
    expect(hookDone).toBe(false); // the hook is still waiting for the start to settle
    release(queue);
    await Promise.all([starting, stopping]);
    expect(queue.worked).toEqual([]);
    expect(queue.stopped).toHaveLength(1);
  });

  it('gives up after a limited number of failed starts, and says so', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const logger = new FakeLogger();
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(logger), make: () => { attempts++; return Promise.reject(new Error('no schema')); } });
    await runner.start();
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * (MAX_START_ATTEMPTS + 5));
    expect(attempts).toBe(MAX_START_ATTEMPTS);
    expect(logger.entries.filter((e) => e.event === 'jobs.unavailable')).toHaveLength(1);
  });

  it('does not wait for ever for a start that hangs (a database that never answers): the hook gives up after a moment, and the queue that comes later is stopped, not set up', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    let release: (q: RecordingQueue) => void = () => undefined;
    const pending = new Promise<RecordingQueue>((resolve) => { release = resolve; });
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => pending });
    void runner.start();
    let done = false;
    const stopping = runner.hook.run().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(START_STOP_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(done).toBe(true);
    release(queue);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.worked).toEqual([]);
    expect(queue.stopped).toEqual([{ graceMs: 0 }]);
  });
});
