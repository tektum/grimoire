import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../../src/events.js';
import { createJobRunner } from '../../src/jobs/runner.js';
import { appUrl } from '../server/support/harness.js';
import { jobsDatabase, makeQueue, runtimeQueue } from './support.js';

const DB = 'grimoire_m7t02_retry';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('a job that always fails, run by the job runner', () => {
  it('is run four times with a growing wait, then lands in dead-letter with its original payload, and jobs.failed is logged once', async () => {
    await makeQueue(DB, 'retry-test', { retryLimit: 3, retryDelaySeconds: 1, retryBackoff: true });
    const logger = new FakeLogger();
    const runs: { attempt: number; retryLimit: number; at: number }[] = [];
    const queues: Awaited<ReturnType<typeof runtimeQueue>>[] = [];
    const runner = createJobRunner({
      config: makeFakeConfig({ database: { url: appUrl(DB) } }), log: createEventLog(logger),
      make: async () => { const q = await runtimeQueue(DB); queues.push(q); return q; },
      jobs: [{ name: 'retry-test', handler: (_p, ctx) => { runs.push({ attempt: ctx.attempt, retryLimit: ctx.retryLimit, at: Date.now() }); return Promise.reject(new Error('always')); } }],
    });
    await runner.start();
    try {
      await queues[0]?.enqueue('retry-test', { tenantId: 'T-retry' });
      await vi.waitFor(async () => {
        const rows = (await db.sql(`select data from pgboss.job where name = 'dead-letter'`)) as { data: unknown }[];
        expect(rows.map((r) => r.data)).toEqual([{ tenantId: 'T-retry' }]);
      }, { timeout: 90_000, interval: 1000 });
    } finally {
      await runner.hook.run();
    }
    expect(runs.map((r) => [r.attempt, r.retryLimit])).toEqual([[1, 3], [2, 3], [3, 3], [4, 3]]);
    const gaps = runs.slice(1).map((r, i) => r.at - (runs[i] as { at: number }).at);
    expect(gaps[2], `waits between runs: ${gaps.join(', ')} ms`).toBeGreaterThan(gaps[0] as number);
    expect(logger.entries.filter((e) => e.event === 'jobs.failed' && (e.fields as { name: string }).name === 'retry-test')).toHaveLength(1);
    expect(logger.entries.filter((e) => e.event === 'jobs.retrying')).toHaveLength(3);
  }, 120_000);
});
