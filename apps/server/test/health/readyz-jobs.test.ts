import type { Database } from '@tektum/grimoire-core/ports/database';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createEventLog } from '../../src/events.js';
import { healthRoutes } from '../../src/health/routes.js';
import type { JobsState } from '../../src/jobs/runner.js';
import { createJobRunner, MAX_START_ATTEMPTS, START_RETRY_MS } from '../../src/jobs/runner.js';

// M7-T00: jobs that have given up are visible: a typed error event for the alarms and a header on /readyz, which stays 200 (the API still serves; replacing the task would not bring jobs back and would take the API with it).
const db: Database = {
  ping: () => Promise.resolve(),
  query<R>(): Promise<readonly R[]> { return Promise.resolve([{ version: '9999_test' }] as unknown as readonly R[]); },
  transaction<T>(): Promise<T> { return Promise.reject(new Error('unused')); },
  close: () => Promise.resolve(),
};
const probe = async (jobs?: () => JobsState) => {
  const app = healthRoutes({ db, clock: new FakeClock(1000), log: createEventLog(new FakeLogger()), expectedMigration: '0001_test', isDraining: () => false, ...(jobs === undefined ? {} : { jobs }) });
  const res = await app.request('/readyz');
  return { status: res.status, body: await res.text(), header: res.headers.get('x-grimoire-jobs') };
};

describe('/readyz and the jobs', () => {
  it('says nothing about jobs for a role that has none, and stays 200 with the state in a header for one that has', async () => {
    expect(await probe()).toEqual({ status: 200, body: 'ok', header: null });
    for (const state of ['starting', 'up', 'down'] as const) expect(await probe(() => state)).toEqual({ status: 200, body: 'ok', header: state });
  });
});

describe('the job runner state', () => {
  const config = makeFakeConfig({ database: { url: 'postgresql://u@127.0.0.1:1/db' } });
  it('is starting, then up once the handlers are registered, then stopped', async () => {
    const queue = { ensureQueue: () => Promise.resolve(), enqueue: () => Promise.resolve(null), isLive: () => Promise.resolve(false), work: () => Promise.resolve(), schedule: () => Promise.resolve(), stop: () => Promise.resolve({ inFlight: 0 }) };
    const runner = createJobRunner({ config, log: createEventLog(new FakeLogger()), make: () => Promise.resolve(queue) });
    expect(runner.state()).toBe('starting');
    await runner.start();
    expect(runner.state()).toBe('up');
    await runner.hook.run();
    expect(runner.state()).toBe('stopped');
  });

  it('is down, with one typed error event, after the last failed start', async () => {
    vi.useFakeTimers();
    try {
      const logger = new FakeLogger();
      const runner = createJobRunner({ config, log: createEventLog(logger), make: () => Promise.reject(new Error('no schema')) });
      await runner.start();
      expect(runner.state()).toBe('starting');
      await vi.advanceTimersByTimeAsync(START_RETRY_MS * (MAX_START_ATTEMPTS + 2));
      expect(runner.state()).toBe('down');
      const gaveUp = logger.entries.filter((e) => e.event === 'jobs.unavailable');
      expect(gaveUp).toEqual([{ level: 'error', event: 'jobs.unavailable', fields: { attempts: MAX_START_ATTEMPTS } }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
