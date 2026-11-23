import assert from 'node:assert/strict';
import type { Database } from '../ports/database.js';
import type { JobQueue } from '../ports/job-queue.js';

/**
 * What a conformance case needs besides the queue. `advance(seconds, until)` lets time pass: the fake moves a
 * virtual clock by `seconds` and runs what is due (it ignores `until`); a real queue cannot skip time, so it
 * waits until `until()` is true instead (and fails when that takes much longer than `seconds`), or returns at
 * once when no `until` is given. `crashWorkers` kills every worker without letting running jobs finish and returns
 * the queue to use afterwards (jobs that were running are given back to it). Every case uses its own queue names.
 */
export interface JobQueueHarness {
  readonly queue: JobQueue;
  readonly database: Database;
  advance(seconds: number, until?: () => boolean): Promise<void>;
  crashWorkers(): Promise<JobQueue>;
}

export interface JobQueueCase { readonly name: string; run(h: JobQueueHarness): Promise<void> }

export const jobQueueCaseNames = ['enqueue', 'delay', 'retry', 'singleton', 'schedule', 'crash-rerun', 'rolled-back-enqueue'] as const;

export const jobQueueConformance: readonly JobQueueCase[] = [
  {
    name: 'enqueue',
    async run({ queue, advance }) {
      const seen: unknown[] = [];
      await queue.work<{ n: number }>('c-enqueue', async (p) => { seen.push(p); });
      const id = await queue.enqueue('c-enqueue', { n: 1 });
      assert.equal(typeof id, 'string');
      await advance(1, () => seen.length === 1);
      assert.deepEqual(seen, [{ n: 1 }]);
    },
  },
  {
    name: 'delay',
    async run({ queue, advance }) {
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
      const attempts: number[] = [];
      await queue.work('c-retry', async (_p, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt < 3) throw new Error('not yet');
      });
      await queue.enqueue('c-retry', {}, { retryLimit: 2 });
      await advance(30, () => attempts.length === 3);
      assert.deepEqual(attempts, [1, 2, 3]);
      let exhausted = 0;
      await queue.work('c-retry-exhausted', async () => { exhausted++; throw new Error('always'); });
      await queue.enqueue('c-retry-exhausted', {}, { retryLimit: 1 });
      await advance(30, () => exhausted === 2);
      assert.equal(exhausted, 2, 'one run plus one retry, then the job is given up');
    },
  },
  {
    name: 'singleton',
    async run({ queue, advance }) {
      let runs = 0;
      await queue.work('c-singleton', async () => { runs++; });
      const first = await queue.enqueue('c-singleton', {}, { singletonKey: 'k', delaySeconds: 5 });
      const second = await queue.enqueue('c-singleton', {}, { singletonKey: 'k', delaySeconds: 5 });
      assert.equal(typeof first, 'string');
      assert.equal(second, null);
      await advance(30, () => runs === 1);
      assert.equal(runs, 1);
    },
  },
  {
    name: 'schedule',
    async run({ queue, advance }) {
      let runs = 0;
      await queue.work('c-schedule', async () => { runs++; });
      await queue.schedule('c-schedule', '* * * * *');
      await advance(125, () => runs >= 1);
      assert.ok(runs >= 1, 'an every-minute schedule fires within two minutes');
    },
  },
  {
    name: 'crash-rerun',
    async run({ queue, advance, crashWorkers }) {
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
    name: 'rolled-back-enqueue',
    async run({ queue, database, advance }) {
      const seen: string[] = [];
      await queue.work<{ v: string }>('c-tx', async (p) => { seen.push(p.v); });
      await assert.rejects(
        database.transaction(async (tx) => {
          await queue.enqueue('c-tx', { v: 'rolled-back' }, {}, tx);
          throw new Error('boom');
        }),
        /boom/,
      );
      await database.transaction(async (tx) => { await queue.enqueue('c-tx', { v: 'committed' }, {}, tx); });
      await advance(5, () => seen.length >= 1);
      assert.deepEqual(seen, ['committed']);
    },
  },
];
