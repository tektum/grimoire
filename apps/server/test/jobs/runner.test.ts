import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobHandler, JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { createJobRunner, MAX_START_ATTEMPTS, START_RETRY_MS, START_STOP_WAIT_MS, type JobsApi } from '../../src/jobs/runner.js';

class RecordingQueue implements JobQueue {
  readonly worked: string[] = [];
  readonly scheduled: string[] = [];
  stopped: { graceMs: number }[] = [];
  inFlight = 0;
  ensureQueue(): Promise<void> { return Promise.resolve(); }
  enqueue(): Promise<string | null> { return Promise.resolve('id'); }
  isLive(): Promise<boolean> { return Promise.resolve(false); }
  failWork = false;
  work(name: string): Promise<void> { if (this.failWork) return Promise.reject(new Error('no queue')); this.worked.push(name); this.order.push(`work ${name}`); return Promise.resolve(); }
  failSchedule = false;
  readonly order: string[] = [];
  schedule(name: string, cron: string): Promise<void> { if (this.failSchedule) return Promise.reject(new Error('no send')); this.scheduled.push(`${name} ${cron}`); this.order.push(`schedule ${name}`); return Promise.resolve(); }
  stop(o: { graceMs: number }): Promise<{ inFlight: number }> { this.stopped.push(o); return Promise.resolve({ inFlight: this.inFlight }); }
}

afterEach(() => { vi.useRealTimers(); });

const scheduledJob = { name: 'purge', schedule: '17 3 * * *', handler: () => Promise.resolve() };
const make = (queue: RecordingQueue, errors: Error[] = [], jobs?: Parameters<typeof createJobRunner>[0]['jobs']) => {
  const logger = new FakeLogger();
  const config = makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' }, jobs: { stopGraceMs: 1234 } });
  const runner = createJobRunner({ config, log: createEventLog(logger), make: () => Promise.resolve(queue), onError: (e) => { errors.push(e); }, ...(jobs === undefined ? {} : { jobs }) });
  return { runner, logger };
};

describe('the job runner', () => {
  it('adds a job to the queue once it is up, with its options, and says so when it is not (the queue is not up yet, or the server is stopping)', async () => {
    const sent: unknown[] = [];
    const queue = new RecordingQueue();
    queue.enqueue = ((name: string, payload: unknown, options?: unknown) => { sent.push([name, payload, options]); return Promise.resolve('job-1'); }) as RecordingQueue['enqueue'];
    const { runner } = make(queue);
    await expect(runner.enqueueImport({ importId: 'i1', tenantId: 't1' })).rejects.toThrow('jobs-unavailable');
    await runner.start();
    await expect(runner.enqueueImport({ importId: 'i1', tenantId: 't1' }, { singletonKey: 'i1' })).resolves.toBe('job-1');
    expect(sent).toEqual([['import', { importId: 'i1', tenantId: 't1' }, { singletonKey: 'i1' }]]);
    await runner.hook.run();
    await expect(runner.enqueueImport({ importId: 'i1', tenantId: 't1' })).rejects.toThrow('jobs-unavailable');
  });

  it('sends the cleanup of each import under a key of its own: the queue keeps one waiting run per key, so a shared slot would drop the cleanup of every import after the first of a burst', async () => {
    const sent: unknown[] = [];
    const queue = new RecordingQueue();
    queue.enqueue = ((name: string, payload: unknown, options?: unknown) => { sent.push([name, payload, options]); return Promise.resolve('job-1'); }) as RecordingQueue['enqueue'];
    const { runner } = make(queue);
    await runner.start();
    await runner.enqueueImportCleanup({ importId: 'i1', tenantId: 't1' });
    await runner.enqueueImportCleanup({ importId: 'i2', tenantId: 't1' });
    expect(sent).toEqual([
      ['import-cleanup', { importId: 'i1', tenantId: 't1' }, { singletonKey: 'import-cleanup:i1' }],
      ['import-cleanup', { importId: 'i2', tenantId: 't1' }, { singletonKey: 'import-cleanup:i2' }],
    ]);
  });

  it('registers a handler for each job of the registry when it starts, and starts once', async () => {
    const queue = new RecordingQueue();
    const { runner } = make(queue);
    await runner.start();
    await runner.start();
    expect(queue.worked).toEqual(['import']);
  });

  it('schedules each job that has a cron, once its handler is registered, so no run is sent to a queue nobody works', async () => {
    const queue = new RecordingQueue();
    await make(queue, [], [scheduledJob, { name: 'import', handler: () => Promise.resolve() }]).runner.start();
    expect(queue.scheduled).toEqual(['purge 17 3 * * *']);
    expect(queue.order.indexOf('schedule purge')).toBeGreaterThan(queue.order.indexOf('work purge'));
  });

  it('sends the first run of a chain at start, after its handler is registered, under its schedule key and its seconds later (every replica does, and the key makes that one run)', async () => {
    const sent: unknown[] = [];
    const queue = new RecordingQueue();
    queue.enqueue = ((name: string, payload: unknown, options?: unknown) => { sent.push([name, payload, options]); queue.order.push(`enqueue ${name}`); return Promise.resolve('job-1'); }) as RecordingQueue['enqueue'];
    await make(queue, [], [{ name: 'embed-sweep', chainSeconds: 15, handler: () => Promise.resolve() }, { name: 'import', handler: () => Promise.resolve() }]).runner.start();
    expect(sent).toEqual([['embed-sweep', undefined, { singletonKey: 'sched:embed-sweep', delaySeconds: 15 }]]);
    expect(queue.order.indexOf('enqueue embed-sweep')).toBeGreaterThan(queue.order.indexOf('work embed-sweep'));
  });

  it('sends a page to embed-page with the ids only, under a key of its own, and the sweep\'s next run under the sweep\'s schedule key', async () => {
    const sent: unknown[] = [];
    const queue = new RecordingQueue();
    queue.enqueue = ((name: string, payload: unknown, options?: unknown) => { sent.push([name, payload, options]); return Promise.resolve('job-1'); }) as RecordingQueue['enqueue'];
    const { runner } = make(queue);
    await expect(runner.enqueueEmbedPage({ tenantId: 't1', pageId: 'p1' })).rejects.toThrow('jobs-unavailable');
    await runner.start();
    await runner.enqueueEmbedPage({ tenantId: 't1', pageId: 'p1' });
    await runner.enqueueEmbedSweep(15);
    expect(sent).toEqual([
      ['embed-page', { tenantId: 't1', pageId: 'p1' }, { singletonKey: 'embed:p1' }],
      ['embed-sweep', undefined, { singletonKey: 'sched:embed-sweep', delaySeconds: 15 }],
    ]);
  });

  it('hands the jobs a queue api that reaches the queue while it is still starting: a run picked up as soon as its handler is registered (one due before a restart) sends its next run, and the api refuses once a stop begins', async () => {
    const sent: unknown[] = [];
    const ran: string[] = [];
    const queue = new RecordingQueue();
    queue.enqueue = ((name: string, payload: unknown, options?: unknown) => { sent.push([name, payload, options]); return Promise.resolve('job-1'); }) as RecordingQueue['enqueue'];
    // pg-boss may fetch a run that is due the moment its handler is registered, before the runner is up
    queue.work = (async (name: string, handler: JobHandler) => {
      queue.worked.push(name);
      await handler(undefined, { jobId: 'j', attempt: 1, retryLimit: 3, signal: new AbortController().signal }).then(() => { ran.push('ok'); }, (e: unknown) => { ran.push((e as Error).message); });
    }) as RecordingQueue['work'];
    let jobsApi: JobsApi | undefined;
    const { runner } = make(queue, [], (api) => { jobsApi = api; return [{ name: 'embed-sweep', chainSeconds: 15, handler: async () => { await api.enqueueEmbedSweep(15); } }]; });
    await runner.start();
    expect(ran).toEqual(['ok']);
    expect(sent[0]).toEqual(['embed-sweep', undefined, { singletonKey: 'sched:embed-sweep', delaySeconds: 15 }]);
    await runner.hook.run();
    await expect(jobsApi?.enqueueEmbedSweep(15)).rejects.toThrow('jobs-unavailable');
  });

  it('counts a schedule that cannot be sent as a failed start: the queue is stopped and the start is tried again', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    queue.failSchedule = true;
    const { runner, logger } = make(queue, [], [scheduledJob]);
    await runner.start();
    expect(runner.state()).toBe('starting');
    expect(queue.stopped).toEqual([{ graceMs: 0 }]);
    expect(logger.entries.filter((e) => e.event === 'jobs.failed')).toHaveLength(1);
    expect(logger.entries.find((e) => e.event === 'jobs.failed')?.fields).toMatchObject({ name: 'queue-start', errorName: 'Error', errorMessage: 'no send' });
    queue.failSchedule = false;
    await vi.advanceTimersByTimeAsync(START_RETRY_MS);
    expect(runner.state()).toBe('up');
    expect(queue.scheduled).toEqual(['purge 17 3 * * *']);
  });

  it('stops with the grace of the settings and logs how many jobs were still running', async () => {
    const queue = new RecordingQueue();
    queue.inFlight = 2;
    const { runner, logger } = make(queue);
    await runner.start();
    await runner.hook.run();
    expect(queue.stopped).toEqual([{ graceMs: 1234 }]);
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
    expect(queue.worked).toEqual(['import']);
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
    expect(made[1]?.worked).toEqual(['import']);
    expect(made[1]?.stopped).toEqual([]);
    await runner.hook.run();
    expect(made[1]?.stopped).toEqual([{ graceMs: 1500 }]);
  });

  it('a stop that comes while the queue is still starting waits for it, registers no handler, and stops that queue', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    let release: (q: RecordingQueue) => void = () => undefined;
    const pending = new Promise<RecordingQueue>((resolve) => { release = resolve; });
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => pending });
    const starting = runner.start();
    let hookDone = false;
    const stopping = runner.hook.run().then(() => { hookDone = true; });
    // Observed, not guessed: the hook has begun (it says so by the state), and for the whole of its wait (half the 1.5 s grace) it has not finished while the start is unsettled.
    expect(runner.state()).toBe('stopped');
    await vi.advanceTimersByTimeAsync(Math.min(START_STOP_WAIT_MS, 1500 / 2) - 1);
    expect(hookDone).toBe(false);
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
    const waitMs = Math.min(START_STOP_WAIT_MS, Math.floor(1500 / 2)); // half of the default grace of 1.5 s
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(done).toBe(true);
    release(queue);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.worked).toEqual([]);
    expect(queue.stopped).toEqual([{ graceMs: 0 }]);
  });

  it('a stop that comes while handlers are being registered registers no more, reports stopped, and stops the queue with what was registered', async () => {
    const queue = new RecordingQueue();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let reached: () => void = () => undefined;
    const firstWork = new Promise<void>((resolve) => { reached = resolve; }); // the first work() call has been made
    queue.work = async (name: string) => { queue.worked.push(name); if (queue.worked.length === 1) { reached(); await gate; } };
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => Promise.resolve(queue) });
    const starting = runner.start();
    await firstWork; // an explicit gate, not a count of microtasks
    const stopping = runner.hook.run();
    open();
    await Promise.all([starting, stopping]);
    expect(queue.worked).toEqual(['import']);
    expect(runner.state()).toBe('stopped');
    expect(queue.stopped).toHaveLength(1);
  });

  it('a start that is abandoned while it registers handlers stops its queue when it comes to the end, and does not report up', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    queue.work = async (name: string) => { queue.worked.push(name); await gate; };
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(new FakeLogger()), make: () => Promise.resolve(queue) });
    void runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = runner.hook.run();
    await vi.advanceTimersByTimeAsync(START_STOP_WAIT_MS);
    await stopping; // gave up waiting
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.stopped).toEqual([{ graceMs: 0 }]);
    expect(runner.state()).toBe('stopped');
  });

  it('the wait for a start and the stop together fit the stop grace: a start that settles 400 ms in leaves the queue only the 1,100 ms that remain', async () => {
    vi.useFakeTimers();
    const queue = new RecordingQueue();
    let release: (q: RecordingQueue) => void = () => undefined;
    const pending = new Promise<RecordingQueue>((resolve) => { release = resolve; });
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' }, jobs: { stopGraceMs: 1500 } }), log: createEventLog(new FakeLogger()), make: () => pending });
    void runner.start();
    const stopping = runner.hook.run();
    await vi.advanceTimersByTimeAsync(400);
    release(queue);
    await stopping;
    expect(queue.stopped).toHaveLength(1);
    expect(queue.stopped[0]!.graceMs).toBeLessThanOrEqual(1100);
    expect(queue.stopped[0]!.graceMs).toBeGreaterThanOrEqual(1);
  });

  it('with a short grace the wait is shorter too, so the hook always finishes inside its own deadline (grace + 500 ms)', async () => {
    vi.useFakeTimers();
    const pending = new Promise<RecordingQueue>(() => undefined);
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' }, jobs: { stopGraceMs: 100 } }), log: createEventLog(new FakeLogger()), make: () => pending });
    void runner.start();
    let done = false;
    const stopping = runner.hook.run().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100 + 500 - 1);
    expect(done).toBe(true);
    await stopping;
  });

  it('a start that fails after the stop began changes nothing: the state stays stopped and no unavailable event is logged', async () => {
    vi.useFakeTimers();
    const logger = new FakeLogger();
    let fail: (e: Error) => void = () => undefined;
    const pending = new Promise<RecordingQueue>((_resolve, reject) => { fail = reject; });
    const runner = createJobRunner({ config: makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } }), log: createEventLog(logger), make: () => pending });
    void runner.start();
    const stopping = runner.hook.run();
    await vi.advanceTimersByTimeAsync(START_STOP_WAIT_MS);
    await stopping;
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(START_RETRY_MS * (MAX_START_ATTEMPTS + 1));
    expect(runner.state()).toBe('stopped');
    expect(logger.entries.filter((e) => e.event === 'jobs.unavailable' || e.event === 'jobs.failed')).toEqual([]);
  });
});
