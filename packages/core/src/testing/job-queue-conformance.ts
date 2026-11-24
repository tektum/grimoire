import assert from 'node:assert/strict';
import type { Database } from '../ports/database.js';
import type { JobContext, JobQueue, QueueDefinition } from '../ports/job-queue.js';

/**
 * What a conformance case needs besides the queue. `advance(seconds, until)` lets time pass: the fake moves a
 * virtual clock by `seconds` and runs what is due (it ignores `until`); a real queue cannot skip time, so it
 * waits until `until()` is true instead (and fails when that takes much longer than `seconds`); when no `until` is
 * given it lets `seconds` of real time pass, so that something that should not happen has the time to. With an `until`, the fake may return as soon as it is true while handlers still run. `crashWorkers` kills every worker without letting running jobs finish and returns
 * the queue to use afterwards (jobs that were running are given back to it). Every case uses its own queue names.
 */
export interface JobQueueHarness {
  readonly queue: JobQueue;
  readonly database: Database;
  advance(seconds: number, until?: () => boolean): Promise<void>;
  crashWorkers(): Promise<JobQueue>;
}

export interface JobQueueCase { readonly name: string; run(h: JobQueueHarness): Promise<void> }

const TENANT = 'tenant_Conf-1';

const def = (name: string, overrides: Partial<QueueDefinition> = {}): QueueDefinition => ({
  name, policy: 'standard', retryLimit: 0, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 900, retentionSeconds: 3600, ...overrides,
});

export const jobQueueCaseNames = [
  'enqueue', 'delay', 'retry', 'crash-rerun',
  'singleton-queued-returns-existing', 'singleton-active-visible-to-isLive', 'handler-gets-attempt-and-signal', 'expiry-aborts-signal',
  'stop-waits-then-aborts', 'enqueue-in-rolled-back-tx-creates-no-job', 'schedule-fires-with-data',
] as const;

export const jobQueueConformance: readonly JobQueueCase[] = [
  {
    name: 'enqueue',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-enqueue'));
      const seen: unknown[] = [];
      await queue.work<{ tenantId: string; n: number }>('c-enqueue', async (p) => { seen.push(p); });
      const id = await queue.enqueue('c-enqueue', { tenantId: TENANT, n: 1 });
      assert.equal(typeof id, 'string');
      await advance(1, () => seen.length === 1);
      assert.deepEqual(seen, [{ tenantId: TENANT, n: 1 }]);
    },
  },
  {
    name: 'delay',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-delay'));
      let runs = 0;
      await queue.work('c-delay', async () => { runs++; });
      await queue.enqueue('c-delay', {}, { delaySeconds: 5 });
      await advance(1);
      assert.equal(runs, 0, 'must not run before the delay has passed');
      await advance(10, () => runs === 1);
      assert.equal(runs, 1);
    },
  },
  {
    name: 'retry',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-retry'));
      const attempts: number[] = [];
      await queue.work('c-retry', async (_p, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt < 3) throw new Error('not yet');
      });
      await queue.enqueue('c-retry', {}, { retryLimit: 2 });
      await advance(30, () => attempts.length === 3);
      assert.deepEqual(attempts, [1, 2, 3]);
      await queue.ensureQueue(def('c-retry-default'));
      let unasked = 0;
      await queue.work('c-retry-default', async () => { unasked++; throw new Error('always'); });
      await queue.enqueue('c-retry-default', {});
      await advance(30, () => unasked >= 1);
      await advance(5); // a failing job without a retry limit is not run again
      assert.equal(unasked, 1);
      await queue.ensureQueue(def('c-retry-exhausted'));
      let exhausted = 0;
      await queue.work('c-retry-exhausted', async () => { exhausted++; throw new Error('always'); });
      await queue.enqueue('c-retry-exhausted', {}, { retryLimit: 1 });
      await advance(30, () => exhausted === 2);
      assert.equal(exhausted, 2, 'one run plus one retry, then the job is given up');
    },
  },
  {
    name: 'crash-rerun',
    async run({ queue, advance, crashWorkers }) {
      await queue.ensureQueue(def('c-crash', { expireInSeconds: 5 }));
      const attempts: string[] = [];
      let fresh: JobQueue | undefined;
      await queue.work('c-crash', async () => {
        attempts.push('first');
        fresh = await crashWorkers();
        throw new Error('the worker died');
      });
      await queue.enqueue('c-crash', {}, { retryLimit: 1 });
      await advance(1, () => fresh !== undefined);
      assert.ok(fresh, 'the first run crashed the workers');
      await fresh.work('c-crash', async () => { attempts.push('second'); });
      await advance(120, () => attempts.length === 2);
      assert.deepEqual(attempts, ['first', 'second']);
    },
  },
  {
    name: 'singleton-queued-returns-existing',
    async run({ queue, database, advance }) {
      await queue.ensureQueue(def('c-single', { policy: 'stately' }));
      let runs = 0;
      await queue.work('c-single', async () => { runs++; });
      const first = await queue.enqueue('c-single', { tenantId: TENANT }, { singletonKey: 'k', delaySeconds: 5 });
      const second = await queue.enqueue('c-single', { tenantId: TENANT }, { singletonKey: 'k', delaySeconds: 5 });
      assert.equal(typeof first, 'string');
      assert.equal(second, first, 'a queued job with the key already exists');
      const other = await queue.enqueue('c-single', { tenantId: TENANT }, { singletonKey: 'other', delaySeconds: 5 });
      assert.notEqual(other, first);
      const [inTx, inTxAgain] = await database.transaction(async (tx) => [
        await queue.enqueue('c-single', { tenantId: TENANT }, { singletonKey: 'tx' }, tx),
        await queue.enqueue('c-single', { tenantId: TENANT }, { singletonKey: 'tx' }, tx),
      ]);
      assert.equal(typeof inTx, 'string');
      assert.equal(inTxAgain, inTx, 'the job of the same uncommitted transaction holds the key');
      await advance(30, () => runs === 3);
      await advance(3); // nothing else was queued
      assert.equal(runs, 3);
    },
  },
  {
    name: 'singleton-active-visible-to-isLive',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-live', { policy: 'stately' }));
      const seen: { jobId: string; live: boolean; continuation: string | null; again: string | null }[] = [];
      let runs = 0;
      await queue.work('c-live', async (_p, ctx) => {
        runs++;
        if (runs > 1) return;
        // The running job sees itself, and may queue its own continuation under its own key; a second send finds that one.
        const live = await queue.isLive('c-live', 'k');
        const continuation = await queue.enqueue('c-live', { tenantId: TENANT }, { singletonKey: 'k' });
        const again = await queue.enqueue('c-live', { tenantId: TENANT }, { singletonKey: 'k' });
        seen.push({ jobId: ctx.jobId, live, continuation, again });
      });
      assert.equal(await queue.isLive('c-live', 'k'), false);
      assert.equal(await queue.isLive('c-live', 'unused'), false);
      await queue.enqueue('c-live', { tenantId: TENANT }, { singletonKey: 'k' });
      await advance(30, () => runs === 2);
      const [first] = seen;
      assert.ok(first);
      assert.equal(first.live, true, 'a running job is live');
      assert.equal(typeof first.continuation, 'string');
      assert.notEqual(first.continuation, first.jobId, 'the continuation is a new job');
      assert.equal(first.again, first.continuation);
      for (let i = 0; i < 20 && (await queue.isLive('c-live', 'k')); i++) await advance(1);
      assert.equal(await queue.isLive('c-live', 'k'), false, 'a finished job is not live');
    },
  },
  {
    name: 'handler-gets-attempt-and-signal',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-ctx', { retryLimit: 1 }));
      const seen: { payload: unknown; ctx: Pick<JobContext, 'attempt' | 'retryLimit'>; id: string; aborted: boolean; isSignal: boolean }[] = [];
      await queue.work('c-ctx', async (payload, ctx) => {
        seen.push({ payload, ctx: { attempt: ctx.attempt, retryLimit: ctx.retryLimit }, id: ctx.jobId, aborted: ctx.signal.aborted, isSignal: ctx.signal instanceof AbortSignal });
        if (ctx.attempt === 1) throw new Error('once');
      });
      const id = await queue.enqueue('c-ctx', { tenantId: TENANT, n: 7 });
      await advance(30, () => seen.length === 2);
      assert.deepEqual(seen.map((s) => s.ctx), [{ attempt: 1, retryLimit: 1 }, { attempt: 2, retryLimit: 1 }]);
      assert.deepEqual(seen.map((s) => s.payload), [{ tenantId: TENANT, n: 7 }, { tenantId: TENANT, n: 7 }]);
      assert.ok(seen.every((s) => s.id === id && !s.aborted && s.isSignal), 'the job id is the enqueue id and the signal is live');
    },
  },
  {
    name: 'expiry-aborts-signal',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-expiry'));
      let aborted = false;
      await queue.work('c-expiry', async (_p, ctx) => {
        await new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => resolve(), { once: true }); });
        aborted = true;
      });
      await queue.enqueue('c-expiry', { tenantId: TENANT }, { expireInSeconds: 4 });
      await advance(10, () => aborted);
      assert.equal(aborted, true, 'the signal aborts before the expiry of the job');
    },
  },
  {
    name: 'stop-waits-then-aborts',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-stop-quick'));
      await queue.ensureQueue(def('c-stop-slow'));
      let started = 0;
      const quick = { done: false, abortedAtEnd: true };
      const slow = { done: false, aborted: false };
      await queue.work('c-stop-quick', async (_p, ctx) => {
        started++;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        quick.abortedAtEnd = ctx.signal.aborted;
        quick.done = true;
      });
      await queue.work('c-stop-slow', async (_p, ctx) => {
        started++;
        await new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => resolve(), { once: true }); });
        slow.aborted = true;
        slow.done = true;
      });
      await queue.enqueue('c-stop-quick', { tenantId: TENANT });
      await queue.enqueue('c-stop-slow', { tenantId: TENANT });
      await advance(10, () => started === 2);
      const { inFlight } = await queue.stop({ graceMs: 2500 });
      assert.equal(quick.done, true, 'stop waits for a handler that finishes within the grace');
      assert.equal(quick.abortedAtEnd, false, 'and does not abort it');
      assert.equal(slow.aborted, true, 'a handler still running when the grace is nearly over gets its signal aborted');
      assert.equal(slow.done, true);
      assert.equal(inFlight, 0, 'both handlers returned before stop did');
    },
  },
  {
    name: 'enqueue-in-rolled-back-tx-creates-no-job',
    async run({ queue, database, advance }) {
      await queue.ensureQueue(def('c-tx'));
      const seen: string[] = [];
      await queue.work<{ tenantId: string; v: string }>('c-tx', async (p) => { seen.push(p.v); });
      await assert.rejects(
        database.transaction(async (tx) => {
          await queue.enqueue('c-tx', { tenantId: TENANT, v: 'rolled-back' }, {}, tx);
          throw new Error('boom');
        }),
        /boom/,
      );
      await database.transaction(async (tx) => { await queue.enqueue('c-tx', { tenantId: TENANT, v: 'committed' }, {}, tx); });
      await advance(5, () => seen.length >= 1);
      assert.deepEqual(seen, ['committed']);
    },
  },
  {
    name: 'schedule-fires-with-data',
    async run({ queue, advance }) {
      await queue.ensureQueue(def('c-schedule'));
      const seen: unknown[] = [];
      await queue.work('c-schedule', async (p) => { seen.push(p); });
      await queue.schedule('c-schedule', '* * * * *', { tenantId: TENANT, scheduled: true });
      await advance(125, () => seen.length >= 1);
      assert.deepEqual(seen[0], { tenantId: TENANT, scheduled: true }, 'an every-minute schedule fires within two minutes with its data');
    },
  },
];
