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
    expect(JSON.stringify(logger.entries)).not.toContain('secret detail');
  });

  it('logs jobs.aborted when the handler returns after its signal aborted', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    const stop = new AbortController();
    await instrument('import', async () => { stop.abort(); }, deps.log, clock)({}, ctx({ signal: stop.signal }));
    expect(events(logger)).toEqual(['info jobs.started', 'warn jobs.aborted', 'info jobs.completed']);
  });
});
