import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { EXIT, installProcessHandlers } from '../../src/lifecycle/process.js';
import type { SignalSource } from '../../src/lifecycle/process.js';
import { Shutdown } from '../../src/lifecycle/shutdown.js';
import { createJsonLogger } from '@tektum/grimoire-adapter-logger-json';
import { compose } from '../../src/composition.js';
import { createRun } from '../../src/lifecycle/run.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(overallDeadlineMs = 5000) {
  const logger = new FakeLogger();
  const shutdown = new Shutdown(new FakeClock());
  const signals = new Map<string, () => void>();
  const faults = new Map<string, (r: unknown) => void>();
  const source: SignalSource = {
    onSignal: (s, l) => { signals.set(s, l); },
    onFault: (k, l) => { faults.set(k, l); },
  };
  const exits: number[] = [];
  installProcessHandlers({ shutdown, log: createEventLog(logger), source, exit: (c) => { exits.push(c); }, overallDeadlineMs });
  return { logger, shutdown, signals, faults, exits };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const names = (l: FakeLogger) => l.entries.map((e) => e.event);

describe('process handlers', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s runs the shutdown and exits 0', async (sig) => {
    const { signals, exits, logger } = setup();
    signals.get(sig)?.();
    await flush();
    expect(exits).toEqual([EXIT.ok]);
    expect(logger.entries[0]).toMatchObject({ event: 'shutdown.started', fields: { reason: sig } });
  });

  it('exits 1 when a hook failed', async () => {
    const { signals, exits, shutdown } = setup();
    shutdown.register({ name: 'bad', phase: 'save-pages', deadlineMs: 10, run: () => Promise.reject(new Error('x')) });
    signals.get('SIGTERM')?.();
    await flush();
    expect(exits).toEqual([EXIT.failure]);
  });

  it('a second signal forces the distinct exit code at once', async () => {
    const { signals, exits, shutdown, logger } = setup();
    shutdown.register({ name: 'hangs', phase: 'save-pages', deadlineMs: 60_000, run: () => new Promise<void>(() => undefined) });
    signals.get('SIGTERM')?.();
    await flush();
    expect(exits).toEqual([]);
    signals.get('SIGINT')?.();
    expect(exits).toEqual([EXIT.forced]);
    expect(names(logger)).toContain('shutdown.second_signal');
    expect(names(logger)).toContain('shutdown.forced');
  });

  it('the overall deadline forces the distinct exit code', async () => {
    const { signals, exits, shutdown, logger } = setup(5000);
    shutdown.register({ name: 'hangs', phase: 'save-pages', deadlineMs: 60_000, run: () => new Promise<void>(() => undefined) });
    signals.get('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(4999);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(exits).toEqual([EXIT.forced]);
    expect(logger.entries.find((e) => e.event === 'shutdown.forced')?.fields).toEqual({ reason: 'overall-deadline', deadlineMs: 5000 });
  });

  it('a clean shutdown cancels the overall deadline', async () => {
    const { signals, exits } = setup(5000);
    signals.get('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exits).toEqual([EXIT.ok]);
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)('%s logs one named event, runs the shutdown and exits non-zero', async (kind) => {
    const { faults, exits, logger, shutdown } = setup();
    const ran = vi.fn(() => Promise.resolve());
    shutdown.register({ name: 'db', phase: 'close-database', deadlineMs: 10, run: ran });
    faults.get(kind)?.(new TypeError('postgres://u:pw@h/db'));
    await flush();
    expect(ran).toHaveBeenCalledOnce();
    expect(exits).toEqual([EXIT.failure]);
    const fault = logger.entries.filter((e) => e.event === 'process.fault');
    expect(fault.map((e) => e.fields)).toEqual([{ kind, errorName: 'TypeError' }]);
    expect(JSON.stringify(logger.entries)).not.toContain('postgres://');
  });
});

describe('start-up refusals outside local mode (R12.22, R8.4)', () => {
  const nonLocal = { GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:1/grimoire', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
  async function start(env: Record<string, string>): Promise<{ code: number | undefined; text: string }> {
    const lines: string[] = [];
    const log = createEventLog(createJsonLogger({ destination: { write: (l) => lines.push(l) } }));
    const c = compose(env);
    let code: number | undefined;
    await createRun({ compose: () => (c.ok ? c : { ...c, log }), exit: (n) => { code = n; } })();
    return { code, text: lines.join('') };
  }

  it('no Descope project id: exit 2 naming GRIMOIRE_DESCOPE_PROJECT_ID', async () => {
    const r = await start(nonLocal);
    expect(r.code).toBe(EXIT.config);
    expect(r.code).toBe(2);
    expect(r.text).toContain('server.config_invalid');
    expect(r.text).toContain('GRIMOIRE_DESCOPE_PROJECT_ID');
  });

  it('a project id but no allowed email domains: exit 2 naming GRIMOIRE_ALLOWED_EMAIL_DOMAINS', async () => {
    const r = await start({ ...nonLocal, GRIMOIRE_DESCOPE_PROJECT_ID: 'P2abc' });
    expect(r.code).toBe(2);
    expect(r.text).toContain('GRIMOIRE_ALLOWED_EMAIL_DOMAINS');
    expect(r.text).not.toContain('P2abc');
  });
});
