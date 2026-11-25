import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../../src/events.js';
import type { RegisteredJob } from '../../src/jobs/index.js';
import { createJobRunner } from '../../src/jobs/runner.js';
import { appUrl } from '../server/support/harness.js';
import { jobsDatabase, makeQueue, runtimeQueue } from './support.js';

// The runner's hook stops the queue with the grace of the settings, which is capped at the release-jobs phase (1.5 s): a handler that finishes inside it is not aborted, one that outlasts it is.
const DB = 'grimoire_m7t02_shutdown';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

const state = async (name: string): Promise<string[]> => ((await db.sql(`select state::text as state from pgboss.job where name = '${name}'`)) as { state: string }[]).map((r) => r.state);

async function start(job: RegisteredJob) {
  const logger = new FakeLogger();
  const queues: Awaited<ReturnType<typeof runtimeQueue>>[] = [];
  const config = makeFakeConfig({ database: { url: appUrl(DB) } });
  const runner = createJobRunner({ config, log: createEventLog(logger), make: async () => { const q = await runtimeQueue(DB); queues.push(q); return q; }, jobs: [job] });
  await runner.start();
  return { runner, logger, queue: queues[0] as Awaited<ReturnType<typeof runtimeQueue>>, grace: config.jobs.stopGraceMs };
}

describe('stopping the job runner', () => {
  it('lets a handler that finishes inside the grace complete, without aborting it', async () => {
    await makeQueue(DB, 'stop-quick');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = { started: false, abortedAtEnd: true, done: false };
    const { runner, logger, queue } = await start({ name: 'stop-quick', handler: async (_p, ctx) => { seen.started = true; await gate; seen.abortedAtEnd = ctx.signal.aborted; seen.done = true; } });
    await queue.enqueue('stop-quick', { tenantId: 'T-s' });
    await vi.waitFor(() => { expect(seen.started).toBe(true); }, { timeout: 30_000, interval: 100 });
    const stopping = runner.hook.run();
    setTimeout(release, 200);
    await stopping;
    expect(seen).toEqual({ started: true, abortedAtEnd: false, done: true });
    expect(logger.entries.find((e) => e.event === 'jobs.stopped')?.fields).toEqual({ inFlight: 0 });
    expect(await state('stop-quick')).toEqual(['completed']);
  }, 90_000);

  it('aborts the signal of a handler that outlasts the grace, and the job completes once the handler returns', async () => {
    await makeQueue(DB, 'stop-slow');
    const seen = { started: false, aborted: false };
    const { runner, logger, queue, grace } = await start({
      name: 'stop-slow',
      handler: async (_p, ctx) => {
        seen.started = true;
        await new Promise<void>((resolve) => { AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]).addEventListener('abort', () => resolve(), { once: true }); });
        seen.aborted = ctx.signal.aborted;
      },
    });
    await queue.enqueue('stop-slow', { tenantId: 'T-s' });
    await vi.waitFor(() => { expect(seen.started).toBe(true); }, { timeout: 30_000, interval: 100 });
    const began = Date.now();
    await runner.hook.run();
    expect(grace, 'the grace is the capped one').toBeLessThanOrEqual(1500);
    expect(seen.aborted, 'the signal aborted before the grace ran out').toBe(true);
    expect(Date.now() - began).toBeLessThan(grace + 2000);
    expect(logger.entries.some((e) => e.event === 'jobs.aborted')).toBe(true);
    expect(await state('stop-slow')).toEqual(['completed']);
  }, 90_000);
});
