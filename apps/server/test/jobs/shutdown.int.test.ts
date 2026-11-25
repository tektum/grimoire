import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../../src/events.js';
import type { RegisteredJob } from '../../src/jobs/index.js';
import { createJobRunner } from '../../src/jobs/runner.js';
import { appUrl } from '../server/support/harness.js';
import { jobsDatabase, makeQueue, runtimeQueue } from './support.js';

// The runner's hook stops the queue with the grace of the settings, which is capped at the release-jobs phase (1.5 s). The adapter aborts the signals at `graceMs - 2000`, at once for a grace this short:
// a handler gets the whole grace to wind down (an import saves its progress and returns), and one that does not is left behind and reported in flight.
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
  it('aborts the signal at once, because the grace is shorter than the two seconds the abort leads by, and a handler that returns inside the grace completes its job', async () => {
    await makeQueue(DB, 'stop-quick');
    const seen = { started: false, abortedAtEnd: false, done: false };
    const { runner, logger, queue, grace } = await start({
      name: 'stop-quick',
      handler: async (_p, ctx) => {
        seen.started = true;
        // The explicit signal, not a timer: the handler returns when told to, which is what an import does (save the progress, enqueue the continuation, return).
        await new Promise<void>((resolve) => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
        seen.abortedAtEnd = ctx.signal.aborted;
        seen.done = true;
      },
    });
    await queue.enqueue('stop-quick', { tenantId: 'T-s' });
    await vi.waitFor(() => { expect(seen.started).toBe(true); }, { timeout: 30_000, interval: 100 });
    await runner.hook.run();
    expect(grace, 'the grace is the capped one').toBeLessThanOrEqual(1500);
    expect(seen).toEqual({ started: true, abortedAtEnd: true, done: true });
    expect(logger.entries.find((e) => e.event === 'jobs.stopped')?.fields).toEqual({ inFlight: 0 });
    expect(logger.entries.some((e) => e.event === 'jobs.aborted')).toBe(true);
    expect(await state('stop-quick')).toEqual(['completed']);
  }, 90_000);

  it('gives up on a handler that ignores its signal and outlasts the grace, and says it was still in flight', async () => {
    await makeQueue(DB, 'stop-slow');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = { started: false, signalAborted: false };
    const { runner, logger, queue, grace } = await start({ name: 'stop-slow', handler: async (_p, ctx) => { seen.started = true; await gate; seen.signalAborted = ctx.signal.aborted; } });
    await queue.enqueue('stop-slow', { tenantId: 'T-s' });
    await vi.waitFor(() => { expect(seen.started).toBe(true); }, { timeout: 30_000, interval: 100 });
    const began = Date.now();
    await runner.hook.run();
    const took = Date.now() - began;
    release(); // only now: after the grace was over and the queue closed
    expect(logger.entries.find((e) => e.event === 'jobs.stopped')?.fields).toEqual({ inFlight: 1 });
    expect(took, `stop took ${String(took)} ms for a grace of ${String(grace)}`).toBeLessThan(grace + 3000);
    await vi.waitFor(() => { expect(seen.signalAborted).toBe(true); }, { timeout: 10_000, interval: 50 }); // the handler saw the abort that stop made
  }, 90_000);
});
