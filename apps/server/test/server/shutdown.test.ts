import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createApp } from '../../src/app.js';
import { createEventLog } from '../../src/events.js';
import { Shutdown, SHUTDOWN_PHASES } from '../../src/lifecycle/shutdown.js';
import type { ShutdownPhase } from '../../src/lifecycle/shutdown.js';
import { makeContext } from './support/context.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const logger = new FakeLogger();
  const clock = new FakeClock();
  return { logger, clock, log: createEventLog(logger), shutdown: new Shutdown(clock) };
}
const events = (l: FakeLogger) => l.entries.map((e) => e.event);

describe('Shutdown', () => {
  it('runs phases in the contracts order and starts hooks in registration order within a phase', async () => {
    const { shutdown, log } = setup();
    const started: string[] = [];
    const hook = (name: string, phase: ShutdownPhase) => ({ name, phase, deadlineMs: 1000, run: async () => { started.push(name); } });
    // registered deliberately out of phase order
    shutdown.register(hook('db', 'close-database'));
    shutdown.register(hook('save-b', 'save-pages'));
    shutdown.register(hook('http', 'stop-accepting'));
    shutdown.register(hook('jobs', 'release-jobs'));
    shutdown.register(hook('save-a', 'save-pages'));
    shutdown.register(hook('timers', 'stop-timers'));
    expect(SHUTDOWN_PHASES).toEqual(['stop-accepting', 'stop-timers', 'save-pages', 'release-jobs', 'close-database']);
    expect(await shutdown.run(log, 'SIGTERM')).toBe(0);
    expect(started).toEqual(['http', 'timers', 'save-b', 'save-a', 'jobs', 'db']);
  });

  it('waits for a whole phase before the next one starts, and runs a phase in parallel', async () => {
    const { shutdown, log } = setup();
    const trace: string[] = [];
    const slow = (name: string, phase: ShutdownPhase, ms: number) => ({
      name, phase, deadlineMs: 10_000,
      run: async () => { trace.push(`${name}:start`); await new Promise((r) => setTimeout(r, ms)); trace.push(`${name}:end`); },
    });
    shutdown.register(slow('a', 'save-pages', 300));
    shutdown.register(slow('b', 'save-pages', 100));
    shutdown.register(slow('c', 'release-jobs', 1));
    const done = shutdown.run(log, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(trace).toEqual(['a:start', 'b:start', 'b:end', 'a:end', 'c:start', 'c:end']);
  });

  it('abandons a hook past its deadline with shutdown.hook_timeout, exits 1, and still runs later phases', async () => {
    const { shutdown, log, logger } = setup();
    const later = vi.fn(() => Promise.resolve());
    shutdown.register({ name: 'hangs', phase: 'save-pages', deadlineMs: 500, run: () => new Promise<void>(() => undefined) });
    shutdown.register({ name: 'db', phase: 'close-database', deadlineMs: 500, run: later });
    const done = shutdown.run(log, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(499);
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(await done).toBe(1);
    expect(later).toHaveBeenCalledOnce();
    const timeout = logger.entries.find((e) => e.event === 'shutdown.hook_timeout');
    expect(timeout).toMatchObject({ level: 'warn', fields: { hook: 'hangs', phase: 'save-pages', deadlineMs: 500 } });
  });

  it('logs shutdown.hook_failed for a throwing hook (name only, no message) and does not stop later phases', async () => {
    const { shutdown, log, logger } = setup();
    const later = vi.fn(() => Promise.resolve());
    const leaked = placeholderDatabaseUrl('h', 'db');
    shutdown.register({ name: 'throws', phase: 'stop-timers', deadlineMs: 500, run: () => { throw new TypeError(leaked); } });
    shutdown.register({ name: 'rejects', phase: 'stop-timers', deadlineMs: 500, run: () => Promise.reject(new RangeError('x')) });
    shutdown.register({ name: 'db', phase: 'close-database', deadlineMs: 500, run: later });
    expect(await shutdown.run(log, 'SIGTERM')).toBe(1);
    expect(later).toHaveBeenCalledOnce();
    const failed = logger.entries.filter((e) => e.event === 'shutdown.hook_failed');
    expect(failed.map((e) => e.fields)).toEqual([
      { hook: 'throws', phase: 'stop-timers', errorName: 'TypeError' },
      { hook: 'rejects', phase: 'stop-timers', errorName: 'RangeError' },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(leaked);
    expect(JSON.stringify(logger.entries)).not.toContain('postgresql://');
  });

  it('does not raise an unhandled rejection when an abandoned hook rejects later', async () => {
    const { shutdown, log } = setup();
    let fail: (e: Error) => void = () => undefined;
    shutdown.register({ name: 'late', phase: 'save-pages', deadlineMs: 10, run: () => new Promise<void>((_, rej) => { fail = rej; }) });
    const done = shutdown.run(log, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(20);
    await done;
    const seen: unknown[] = [];
    const onRejection = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onRejection);
    fail(new Error('too late'));
    vi.useRealTimers(); // setImmediate is faked otherwise
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', onRejection);
    expect(seen).toEqual([]);
  });

  it('records hook duration from the clock and logs nothing but named events', async () => {
    const { shutdown, log, logger, clock } = setup();
    shutdown.register({ name: 'save', phase: 'save-pages', deadlineMs: 1000, run: async () => { clock.advance(250); } });
    await shutdown.run(log, 'SIGINT');
    expect(events(logger)).toEqual(['shutdown.started', 'shutdown.phase_started', 'shutdown.hook_done', 'shutdown.completed']);
    expect(logger.entries[2]?.fields).toEqual({ hook: 'save', phase: 'save-pages', ms: 250 });
  });

  it('a signal that arrives while the cleanup of a failed start runs joins it: the hooks run once and draining is set', async () => {
    const { shutdown, log } = setup();
    let runs = 0;
    let release: () => void = () => undefined;
    shutdown.register({ name: 'slow', phase: 'stop-accepting', deadlineMs: 5000, run: async () => { runs++; await new Promise<void>((resolve) => { release = resolve; }); } });
    const first = shutdown.runStartupFailure(log);
    expect(shutdown.isDraining()).toBe(true);
    const second = shutdown.run(log, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    release();
    expect(await first).toBe(0);
    expect(await second).toBe(0);
    expect(runs).toBe(1);
  });

  it('is idempotent: a second run returns the same result without rerunning hooks', async () => {
    const { shutdown, log } = setup();
    const run = vi.fn(() => Promise.resolve());
    shutdown.register({ name: 'h', phase: 'save-pages', deadlineMs: 100, run });
    const [a, b] = await Promise.all([shutdown.run(log, 'SIGTERM'), shutdown.run(log, 'SIGINT')]);
    expect([a, b]).toEqual([0, 0]);
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses registration after shutdown started', async () => {
    const { shutdown, log } = setup();
    await shutdown.run(log, 'SIGTERM');
    expect(() => { shutdown.register({ name: 'x', phase: 'save-pages', deadlineMs: 1, run: () => Promise.resolve() }); }).toThrow();
  });

  it('/readyz already returns 503 when the first hook starts (draining is set before any hook runs)', async () => {
    const { ctx, shutdown, logger } = makeContext();
    const app = createApp(ctx);
    expect((await app.request('/readyz')).status).toBe(200);
    let seen: { status: number; body: string } | undefined;
    shutdown.register({
      name: 'probe', phase: 'stop-accepting', deadlineMs: 1000,
      run: async () => {
        const res = await app.request('/readyz');
        seen = { status: res.status, body: await res.text() };
      },
    });
    await shutdown.run(ctx.log, 'SIGTERM');
    expect(seen).toEqual({ status: 503, body: 'unavailable' });
    expect((await app.request('/healthz')).status).toBe(200);
    expect(events(logger)[0]).toBe('shutdown.started');
  });
});
