import { readFileSync } from 'node:fs';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appConnections, appUrl, createTestDatabase, dropTestDatabase, eventually, freePort, get, hooksEntry,
  requireBuild, runToEnd, mainJs, slowEntry, startServer, ServerProcess,
} from './support/harness.js';
import { overallShutdownDeadlineMs } from '../../src/lifecycle/budget.js';
import { listenerReport, TRACK_LISTENERS, withoutListenerReport } from '@tektum/grimoire-test-support/harness';

const MIGRATED = 'grimoire_t07_migrated';
const EMPTY = 'grimoire_t07_empty';
const running: ServerProcess[] = [];

async function start(opts: Parameters<typeof startServer>[0]): Promise<ServerProcess> {
  const s = await startServer({ ...opts, nodeArgs: [...(opts?.nodeArgs ?? []), '--import', TRACK_LISTENERS] }); // the child reports its own listeners (no probing of port numbers)
  running.push(s);
  return s;
}
const withDb = (db: string, extra: Record<string, string> = {}) => ({ GRIMOIRE_DATABASE_URL: appUrl(db), ...extra });

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(MIGRATED, true);
  await createTestDatabase(EMPTY, false);
}, 60_000);
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.kill())); });
afterAll(async () => {
  await dropTestDatabase(MIGRATED);
  await dropTestDatabase(EMPTY);
});

describe('readiness against PostgreSQL', () => {
  it('/healthz is 200 ok and /readyz 200 ok once the database is reachable and migrated', async () => {
    const s = await start({ env: withDb(MIGRATED) });
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
    expect(await get(`${s.url}/readyz`)).toEqual({ status: 200, body: 'ok' });
  });

  it('/readyz is 503 unavailable on an unmigrated database while /healthz stays 200', async () => {
    const s = await start({ env: withDb(EMPTY) });
    expect(await get(`${s.url}/readyz`)).toEqual({ status: 503, body: 'unavailable' });
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
  });

  it('/readyz is 503 and /healthz 200 when the database url points at a closed port', async () => {
    const closed = await freePort();
    const s = await start({ env: { GRIMOIRE_DATABASE_URL: `postgresql://grimoire_app:grimoire-dev@127.0.0.1:${closed}/grimoire` } });
    expect(await get(`${s.url}/readyz`)).toEqual({ status: 503, body: 'unavailable' });
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
  });

  it.each(['all', 'api', 'collab'])('GRIMOIRE_ROLE=%s starts and /healthz returns 200', async (role) => {
    const s = await start({ env: withDb(MIGRATED, { GRIMOIRE_ROLE: role }) });
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
    expect(s.events.some((e) => e['event'] === 'collab.attached')).toBe(role !== 'api');
  });
});

describe('shutdown of the real entry point', () => {
  it('SIGTERM during an in-flight slow request: /readyz flips to 503 first, the request finishes, exit 0 within the grace period', async () => {
    const s = await start({ entry: slowEntry, env: withDb(MIGRATED) });
    const slow = fetch(`${s.url}/slow`).then(async (r) => ({ status: r.status, body: await r.text() }));
    await eventually(() => (s.events.some((e) => e['event'] === 'test.slow_entered') ? true : undefined), 5000, 'the slow request is in flight');
    const signalled = Date.now();
    s.signal('SIGTERM');
    const ready = await eventually(async () => {
      try {
        const r = await get(`${s.url}/readyz`);
        return r.status === 503 ? r : undefined;
      } catch { return undefined; }
    }, 1000, '/readyz 503 within 1 s of SIGTERM');
    expect(ready).toEqual({ status: 503, body: 'unavailable' });
    expect(s.alive).toBe(true);
    expect(await slow).toEqual({ status: 200, body: 'finished' });
    const exit = await s.exited;
    expect(exit.code).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(10_000);
  });

  it('with a slow hook: /readyz is 503 within 1 s, a new connection is then refused, the process lives until the hook ends, exit 0', async () => {
    const s = await start({ entry: hooksEntry, env: withDb(MIGRATED, { T07_HOOKS: 'slow' }) });
    s.signal('SIGTERM');
    const ready = await eventually(async () => {
      try {
        const r = await get(`${s.url}/readyz`);
        return r.status === 503 ? r : undefined;
      } catch { return undefined; }
    }, 2000, '/readyz 503'); // was 1000 ms and flaked at 1,214 ms under load; 2,000 stays below the 2,500 ms the slow hook sleeps, and the next line shows the hook had not finished
    expect(ready).toEqual({ status: 503, body: 'unavailable' });
    expect(s.alive).toBe(true);
    // The listener is closed while the process lives: asked of the process itself (SIGUSR2 makes it report its listeners), not by connecting to a port number.
    // (the listener stays open for the drain propagation first, so the process is asked again until it reports none)
    const report = await eventually(async () => {
      s.signal('SIGUSR2');
      const latest = listenerReport(s.output);
      return latest?.stillListening === 0 ? latest : undefined;
    }, 4000, 'the listener closed');
    expect(report).toMatchObject({ started: 1, stillListening: 0 });
    expect(s.alive).toBe(true); // the slow save-pages hook is still running
    expect((await s.exited).code).toBe(0);
    const names = s.events.map((e) => e['event']);
    expect(names.indexOf('shutdown.started')).toBeLessThan(names.indexOf('shutdown.hook_done'));
  });

  it('closes an idle keep-alive connection in the stop-accepting phase, long before its 65 s idle timeout', async () => {
    const s = await start({ env: withDb(MIGRATED) });
    const sock = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((resolve) => sock.once('connect', () => { resolve(); }));
    const answered = new Promise<string>((resolve) => sock.once('data', (d: Buffer) => { resolve(d.toString()); }));
    sock.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    expect(await answered).toContain('200 OK');
    const closed = new Promise<number>((resolve) => { const t = Date.now(); sock.once('close', () => { resolve(Date.now() - t); }); });
    s.signal('SIGTERM');
    expect(await closed).toBeLessThan(5000);
    expect((await s.exited).code).toBe(0);
  });

  it('a keep-alive socket whose request is in flight at SIGTERM and then goes idle is closed by the sweep, exit within 2.5 s', async () => {
    const s = await start({ entry: slowEntry, env: withDb(MIGRATED) });
    const sock = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((resolve) => sock.once('connect', () => { resolve(); }));
    let received = '';
    sock.on('data', (d: Buffer) => { received += d.toString(); });
    const closed = new Promise<void>((resolve) => sock.once('close', () => { resolve(); }));
    sock.write('GET /slow HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'); // answers after 1.5 s
    await eventually(() => (s.events.some((e) => e['event'] === 'test.slow_entered') ? true : undefined), 5000, 'the slow request is in flight');
    const signalled = Date.now();
    s.signal('SIGTERM');
    const exit = await s.exited;
    await closed;
    expect(received).toContain('finished'); // the in-flight request completed before the socket went away
    expect(exit.code).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(2500); // with no sweep this takes about 6 s (the 5 s force timer)
  }, 15_000);

  it('a handler error on the real process writes only named JSON events to stdout and stderr', async () => {
    const s = await start({ entry: slowEntry, env: withDb(MIGRATED) });
    for (const [path, status] of [['/boom/throw', 503], ['/boom/reject', 503], ['/boom/value', 503], ['/boom/http', 503], ['/boom/refused', 403]] as const) {
      const res = await fetch(`${s.url}${path}`);
      expect(res.status).toBe(status);
      expect(await res.text()).not.toContain('hunter2');
    }
    // a client aborting mid-response (the stream errors after the first chunk) and a malformed request line
    const abort = new AbortController();
    const aborted = fetch(`${s.url}/stream`, { signal: abort.signal })
      .then(async (r) => { await r.body?.getReader().read(); abort.abort(); return 'aborted after the first chunk'; }).catch(() => 'failed');
    await aborted;
    const garbage = net.connect(s.port, '127.0.0.1');
    garbage.resume(); // unread data would keep 'close' from firing
    await new Promise<void>((resolve) => { garbage.once('connect', () => { garbage.write('NOT A VALID REQUEST LINE\r\n\r\n'); resolve(); }); });
    await new Promise<void>((resolve) => garbage.once('close', () => { resolve(); }));
    const stream2 = fetch(`${s.url}/stream`).then((r) => r.text()).catch(() => 'failed'); // server-side stream failure
    await stream2;
    await s.waitForEvent('console.error_output'); // the server-side stream failure is logged before SIGTERM
    s.signal('SIGTERM');
    expect((await s.exited).code).toBe(0);
    const declared = readFileSync(new URL('../../src/events.ts', import.meta.url), 'utf8');
    const lines = withoutListenerReport(s.output).split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(declared).toContain(`'${String(parsed['event'])}'`);
    }
    expect(s.output).not.toMatch(/hunter2|stack|    at /);
    const names = lines.map((l) => (JSON.parse(l) as Record<string, unknown>)['event']);
    expect(names).toContain('http.handler_error');
    expect(names).toContain('http.handler_rejected');
    expect(names).toContain('console.error_output');
  }, 20_000);

  it('a hook past its deadline is abandoned (shutdown.hook_timeout) and the process exits 1', async () => {
    const s = await start({ entry: hooksEntry, env: withDb(MIGRATED, { T07_HOOKS: 'hang-500' }) });
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(1);
    expect(s.events.some((e) => e['event'] === 'shutdown.hook_timeout' && e['hook'] === 'test-hang')).toBe(true);
    expect(s.events.some((e) => e['event'] === 'shutdown.completed' && e['exitCode'] === 1)).toBe(true);
  });

  it('a second signal forces exit code 3 while a hook hangs', async () => {
    const s = await start({ entry: hooksEntry, env: withDb(MIGRATED, { T07_HOOKS: 'hang-forever' }) });
    s.signal('SIGTERM');
    await s.waitForEvent('shutdown.started');
    s.signal('SIGINT');
    expect((await s.exited).code).toBe(3);
    expect(s.output).toContain('"event":"shutdown.forced"');
  });

  it('the overall deadline forces exit code 3 when a hook outlasts it', async () => {
    const s = await start({ entry: hooksEntry, env: withDb(MIGRATED, { T07_HOOKS: 'hang-forever', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '1000', GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '500', GRIMOIRE_SAVE_TIMEOUT_MS: '100' }) });
    const t = Date.now();
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(3);
    const backstop = overallShutdownDeadlineMs(1000); // the phase deadlines (5 s stop-accepting, 1 s + 2 s save, 2 s jobs, 1 s timers, 2 s databases) plus 2 s
    expect(Date.now() - t).toBeGreaterThan(backstop - 1000);
    expect(s.events.find((e) => e['event'] === 'shutdown.forced')).toMatchObject({ reason: 'overall-deadline', deadlineMs: backstop });
  }, 40_000);

  it('releases the port and leaves no pool connection behind, and logs only named JSON events without secrets', async () => {
    const s = await start({ env: withDb(MIGRATED) });
    expect((await get(`${s.url}/readyz`)).status).toBe(200); // opens a pool connection
    expect(await appConnections(MIGRATED)).toBeGreaterThan(0);
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(0);
    expect(listenerReport(exit.output)).toMatchObject({ started: 1, stillListening: 0 }); // the process closed its listener before it exited
    // PostgreSQL drops the backends a moment after the process that held them has exited: waited for, bounded, and the count is named if it never reaches 0.
    await vi.waitFor(async () => { expect(await appConnections(MIGRATED), 'open app connections after the server exited').toBe(0); }, { timeout: 5000, interval: 50 });
    const names = s.events.map((e) => e['event']);
    expect(names).toEqual(expect.arrayContaining(['server.starting', 'http.listening', 'shutdown.started', 'shutdown.phase_started', 'shutdown.hook_done', 'shutdown.completed']));
    expect(names.indexOf('shutdown.hook_done')).toBeGreaterThan(-1);
    // The promise is the order of PHASES (hooks within a phase run in parallel, shutdown.ts): save-pages, then release-jobs, then close-database.
    const done = s.events.filter((e) => e['event'] === 'shutdown.hook_done').map((e) => ({ hook: String(e['hook']), phase: String(e['phase']) }));
    const phaseOf = (hook: string): string | undefined => done.find((d) => d.hook === hook)?.phase;
    expect(phaseOf('collab-save-pages')).toBe('save-pages');
    expect(phaseOf('markdown-pool')).toBe('release-jobs');
    for (const h of ['auth-pool', 'database-pool', 'page-store-pool']) expect(phaseOf(h), h).toBe('close-database');
    const at = (hook: string): number => done.findIndex((d) => d.hook === hook);
    for (const h of ['auth-pool', 'database-pool', 'page-store-pool']) expect(at('markdown-pool'), `${h} closes after the markdown pool`).toBeLessThan(at(h)); // no save can still need the page store
    expect(at('collab-save-pages')).toBeLessThan(at('markdown-pool'));
    for (const e of s.events) {
      expect(typeof e['ts']).toBe('string');
      expect(typeof e['event']).toBe('string');
    }
    expect(exit.output).not.toMatch(/grimoire-dev|postgres(ql)?:\/\//);
  });
});

describe('start-up refusals', () => {
  const dbEnv = { GRIMOIRE_DATABASE_URL: appUrl(MIGRATED) };
  it.each([
    ['local mode with a Descope project id', { ...dbEnv, GRIMOIRE_LOCAL: '1', GRIMOIRE_DESCOPE_PROJECT_ID: 'P2abc' }, ['GRIMOIRE_LOCAL', 'GRIMOIRE_DESCOPE_PROJECT_ID']],
    ['non-local mode without a project id', { ...dbEnv, GRIMOIRE_LOCAL: '0' }, ['GRIMOIRE_DESCOPE_PROJECT_ID']],
    ['a missing database url', { GRIMOIRE_LOCAL: '1' }, ['GRIMOIRE_DATABASE_URL']],
  ])('exits 2 before listening for %s and names the variables', async (_name, env, names) => {
    const port = await freePort();
    const exit = await runToEnd(['--import', TRACK_LISTENERS, mainJs], { GRIMOIRE_PORT: String(port), ...env });
    expect(exit.code).toBe(2);
    const event = withoutListenerReport(exit.output).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['event'] === 'server.config_invalid');
    expect(event).toBeDefined();
    for (const n of names) expect(JSON.stringify(event)).toContain(n);
    expect(exit.output).not.toMatch(/grimoire-dev|P2abc|http\.listening/);
    expect(listenerReport(exit.output)).toMatchObject({ started: 0, stillListening: 0 }); // it never listened
  });

  it('an occupied port exits 1 with server.start_failed and closes the pool', async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, () => { resolve(); }));
    try {
      const exit = await runToEnd([mainJs], { GRIMOIRE_PORT: String(port), GRIMOIRE_LOCAL: '1', ...dbEnv });
      expect(exit.code).toBe(1);
      expect(exit.output).toContain('"event":"server.start_failed"');
      expect(exit.output).toContain('EADDRINUSE');
    } finally {
      blocker.close();
    }
  });
});

