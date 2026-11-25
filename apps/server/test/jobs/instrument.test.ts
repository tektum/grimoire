import { describe, expect, it } from 'vitest';
import { instrument } from '../../src/jobs/instrument.js';
import { fakeJobDeps } from './deps.js';

const ctx = (over: { attempt?: number; retryLimit?: number; signal?: AbortSignal } = {}) => ({ jobId: 'j1', attempt: 1, retryLimit: 3, signal: new AbortController().signal, ...over });
const events = (logger: ReturnType<typeof fakeJobDeps>['logger']) => logger.entries.map((e) => `${e.level} ${e.event}`);

describe('instrument', () => {
  it('logs the start and the completion of a run, with its duration', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    await instrument('purge', async () => { clock.advance(40); }, deps.log, clock)({}, ctx());
    expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([
      ['jobs.started', { name: 'purge', jobId: 'j1', attempt: 1, ms: 0 }],
      ['jobs.completed', { name: 'purge', jobId: 'j1', attempt: 1, ms: 40 }],
    ]);
  });

  it('logs a failure as retrying while retries remain and as failed on the last run, and rethrows it', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    const run = instrument('purge', () => Promise.reject(new Error('secret detail')), deps.log, clock);
    await expect(run({}, ctx({ attempt: 3 }))).rejects.toThrow('secret detail');
    await expect(run({}, ctx({ attempt: 4 }))).rejects.toThrow('secret detail');
    expect(events(logger)).toEqual(['info jobs.started', 'warn jobs.retrying', 'info jobs.started', 'error jobs.failed']);
  });

  it('says why a run failed: the class of the error and its message, cut and with control characters taken out, on both the retry and the final failure', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    class QuotaError extends Error { constructor(m: string) { super(m); this.name = 'QuotaError'; } }
    const failing = (e: unknown) => instrument('purge', () => Promise.reject(e), deps.log, clock);
    await expect(failing(new QuotaError('no space\nleft'))({}, ctx({ attempt: 1 }))).rejects.toThrow();
    await expect(failing(new TypeError('x'.repeat(500)))({}, ctx({ attempt: 4 }))).rejects.toThrow();
    await expect(failing('just a string')({}, ctx({ attempt: 2 }))).rejects.toBe('just a string');
    const failures = logger.entries.filter((e) => e.event === 'jobs.retrying' || e.event === 'jobs.failed');
    expect(failures.map((e) => [e.event, (e.fields as { errorName: string }).errorName, (e.fields as { errorMessage: string }).errorMessage])).toEqual([
      ['jobs.retrying', 'QuotaError', 'no space left'],
      ['jobs.failed', 'TypeError', 'x'.repeat(200)],
      ['jobs.retrying', 'NonError', 'just a string'],
    ]);
    expect(failures[0]?.fields).toMatchObject({ name: 'purge', jobId: 'j1', attempt: 1 });
  });

  it('does not log the payload of the job', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    await expect(instrument('purge', () => Promise.reject(new Error('boom')), deps.log, clock)({ tenantId: 'T-secret-tenant' }, ctx())).rejects.toThrow();
    expect(JSON.stringify(logger.entries)).not.toContain('T-secret-tenant');
  });

  it('logs jobs.aborted when the handler returns after its signal aborted', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    const stop = new AbortController();
    await instrument('import', async () => { stop.abort(); }, deps.log, clock)({}, ctx({ signal: stop.signal }));
    expect(events(logger)).toEqual(['info jobs.started', 'warn jobs.aborted', 'info jobs.completed']);
  });
});
