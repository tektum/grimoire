import { describe, expect, it } from 'vitest';
import type { JobHandler, JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { createJobRunner } from '../../src/jobs/runner.js';

// The registry of the composition root plugs into the runner (M7-T02): the runner registers the jobs it is given, each one wrapped so that a run is logged by id and number.
function queueStub() {
  const handlers = new Map<string, JobHandler>();
  const queue = {
    ensureQueue: () => Promise.resolve(), enqueue: () => Promise.resolve('id'), isLive: () => Promise.resolve(false), schedule: () => Promise.resolve(),
    work: <P>(name: string, handler: JobHandler<P>) => { handlers.set(name, handler as JobHandler); return Promise.resolve(); },
    stop: () => Promise.resolve({ inFlight: 0 }),
  } satisfies JobQueue;
  return { queue, handlers };
}
const ctx = { jobId: 'j1', attempt: 1, retryLimit: 3, signal: new AbortController().signal };
const config = makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } });

describe('the job runner and the registry', () => {
  it('registers the jobs it is given, not the import jobs, and runs each through the run log', async () => {
    const { queue, handlers } = queueStub();
    const logger = new FakeLogger();
    const clock = new FakeClock(0);
    const ran: string[] = [];
    const runner = createJobRunner({
      config, log: createEventLog(logger), clock, make: () => Promise.resolve(queue),
      jobs: [{ name: 'purge', handler: () => { ran.push('purge'); clock.advance(25); return Promise.resolve(); } }, { name: 'markdown-sweep', handler: () => Promise.reject(new Error('detail')) }],
    });
    await runner.start();
    expect([...handlers.keys()]).toEqual(['purge', 'markdown-sweep']);
    await handlers.get('purge')?.({}, ctx);
    await expect(handlers.get('markdown-sweep')?.({}, { ...ctx, attempt: 4 })).rejects.toThrow('detail');
    expect(ran).toEqual(['purge']);
    expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([
      ['jobs.started', { name: 'purge', jobId: 'j1', attempt: 1, ms: 0 }],
      ['jobs.completed', { name: 'purge', jobId: 'j1', attempt: 1, ms: 25 }],
      ['jobs.started', { name: 'markdown-sweep', jobId: 'j1', attempt: 4, ms: 0 }],
      ['jobs.failed', { name: 'markdown-sweep', jobId: 'j1', attempt: 4, ms: 0 }],
    ]);
  });

  it('runs on the system clock when it is given none', async () => {
    const { queue, handlers } = queueStub();
    const logger = new FakeLogger();
    await createJobRunner({ config, log: createEventLog(logger), make: () => Promise.resolve(queue), jobs: [{ name: 'x', handler: () => Promise.resolve() }] }).start();
    await handlers.get('x')?.({}, ctx);
    expect(logger.entries.map((e) => e.event)).toEqual(['jobs.started', 'jobs.completed']);
    expect((logger.entries[1]?.fields as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  it('schedules every job of the registry that carries a cron, with that cron', async () => {
    const scheduled: string[] = [];
    const { queue } = queueStub();
    const jobs = [{ name: 'purge', schedule: '17 3 * * *', handler: () => Promise.resolve() }, { name: 'import', handler: () => Promise.resolve() }, { name: 'markdown-sweep', schedule: '* * * * *', handler: () => Promise.resolve() }];
    const runner = createJobRunner({ config, log: createEventLog(new FakeLogger()), make: () => Promise.resolve({ ...queue, schedule: (name: string, cron: string) => { scheduled.push(`${name} ${cron}`); return Promise.resolve(); } }), jobs });
    await runner.start();
    expect(scheduled).toEqual(['purge 17 3 * * *', 'markdown-sweep * * * * *']);
  });
});
