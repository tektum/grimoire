import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { ALLOWED_ORIGIN, connect, eventually, newPage, seedPage, synced, wsUrl } from './support.js';
import type { Client } from './support.js';

const DB = 'grimoire_t11_upgrade';
const running: ServerProcess[] = [];
const clients: Client[] = [];
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...env } });
  running.push(s);
  return s;
}

interface Probe { status: number; close: () => void }
/** A hand-written upgrade request: the status line is the answer; an accepted socket stays open until `close`. */
function upgrade(port: number, headers: Record<string, string | string[]>, localAddress = '127.0.0.1'): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port, host: '127.0.0.1', localAddress, path: '/collab',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (res, socket) => { resolve({ status: res.statusCode ?? 0, close: () => { socket.destroy(); } }); });
    req.on('response', (res) => { res.resume(); res.on('end', () => { resolve({ status: res.statusCode ?? 0, close: () => undefined }); }); });
    req.on('error', reject);
    req.end();
  });
}
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);
const good = { Origin: ALLOWED_ORIGIN };

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
}, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('origin check (R12.15)', () => {
  it('an allowed origin connects with a provider; wrong, missing, lookalike and doubled origins get 403 before any handshake', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = connect(wsUrl(s.port), page); clients.push(c);
    await synced(c);
    for (const headers of [
      { Origin: 'https://evil.example' }, {}, { Origin: 'null' }, { Origin: `${ALLOWED_ORIGIN}.evil.test` }, { Origin: `${ALLOWED_ORIGIN}/` },
      { Origin: 'http://127.0.0.1:8081' }, { Origin: [ALLOWED_ORIGIN, ALLOWED_ORIGIN] },
    ]) {
      const p = await upgrade(s.port, headers);
      expect(p.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await upgrade(s.port, good)).status).toBe(101);
    // Seven refusals in one window: the first is logged at once, the other six are counted in the summary line that ends the window (log-throttle.ts).
    expect(events(s, 'collab.upgrade_refused')).toHaveLength(1);
    await s.waitForEvent('collab.log_suppressed', 15_000);
    expect(events(s, 'collab.log_suppressed').map((e) => [e['suppressedEvent'], e['variant'], e['count']])).toEqual([['collab.upgrade_refused', 'origin', 6]]);
    expect(events(s, 'collab.upgrade_refused').every((e) => JSON.stringify(e).includes('"origin"') && !JSON.stringify(e).includes('evil'))).toBe(true);
    expect(events(s, 'collab.connected')).toHaveLength(1); // only the provider reached authentication
  }, 30_000);
});

/** An upgrade that is accepted and then dropped without authenticating: one failed attempt. */
async function failedAttempt(port: number, headers: Record<string, string | string[]>, localAddress?: string): Promise<number> {
  const p = await upgrade(port, headers, localAddress);
  p.close();
  if (p.status === 101) await new Promise((r) => setTimeout(r, 5)); // let the server see the close before the next attempt
  return p.status;
}
const retryAfter = (port: number, headers: Record<string, string>): Promise<string | undefined> => new Promise((resolve, reject) => {
  const req = http.request({ port, host: '127.0.0.1', path: '/collab', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
  req.on('response', (res) => { res.resume(); resolve(res.headers['retry-after']); });
  req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(undefined); });
  req.on('error', reject);
  req.end();
});

describe('per-address attempts that do not authenticate (R4.19)', () => {
  it('50 failed attempts from one address are accepted, the 51st gets 429 with Retry-After; another address is unaffected; a forged X-Forwarded-For does not help', async () => {
    const s = await start();
    for (let i = 0; i < 50; i += 1) expect(await failedAttempt(s.port, { ...good, 'X-Forwarded-For': `9.9.9.${String(i)}` })).toBe(101);
    // The guard charges a failed attempt when it sees the socket close (in the server process): the 51st request is polled until the ban shows, not sent after a guessed pause.
    let accepted = 0;
    expect(await eventually(async () => { const r = await retryAfter(s.port, { ...good, 'X-Forwarded-For': '9.9.9.250' }); if (r === undefined) accepted++; return r; }, 8000, 'the ban shows on a further attempt')).toBe('300');
    expect(accepted, 'the ban starts at the 51st attempt: at most a couple of probes may be accepted while the server counts the closes').toBeLessThanOrEqual(3);
    expect((await upgrade(s.port, good, '127.0.0.2')).status).toBe(101);
  });

  it('behind a trusted proxy the forwarded address is the client: separate counts, and a forged left-most value frames nobody', async () => {
    const s = await start({ GRIMOIRE_TRUSTED_PROXY: '127.0.0.1' });
    for (let i = 0; i < 50; i += 1) expect(await failedAttempt(s.port, { ...good, 'X-Forwarded-For': '198.51.100.1' })).toBe(101);
    let accepted = 0;
    await eventually(async () => { const r = await upgrade(s.port, { ...good, 'X-Forwarded-For': '198.51.100.1' }); if (r.status === 429) return true; accepted++; r.close(); return undefined; }, 8000, 'the ban shows on a further attempt (429)');
    expect(accepted, 'the ban starts at the 51st attempt').toBeLessThanOrEqual(3);
    const second = await upgrade(s.port, { ...good, 'X-Forwarded-For': '198.51.100.2' });
    expect(second.status).toBe(101);
    const framed = await upgrade(s.port, { ...good, 'X-Forwarded-For': '198.51.100.1, 198.51.100.3' }); // the proxy appended .3: the client is .3
    expect(framed.status).toBe(101);
    second.close(); framed.close();
  });

  it('500 bad-Origin upgrades from one address do not count: an honest client from the same address still connects', async () => {
    const s = await start();
    for (let i = 0; i < 500; i += 1) expect((await upgrade(s.port, { Origin: 'https://evil.example' })).status).toBe(403);
    const page = newPage(); await seedPage(DB, page);
    const c = connect(wsUrl(s.port), page); clients.push(c);
    await synced(c);
  });

  it('40 failures, then 30 honest users: they all connect', async () => {
    const s = await start();
    for (let i = 0; i < 40; i += 1) await failedAttempt(s.port, good);
    const page = newPage(); await seedPage(DB, page);
    const cs = Array.from({ length: 30 }, (_, i) => connect(wsUrl(s.port), page, `dev:test-secret-0123456789abcdef:user${String(i)}:member`));
    clients.push(...cs);
    await Promise.all(cs.map(synced));
  });
});

describe('development tokens carry the secret', () => {
  it('a token without the secret, or with a wrong one, is refused with invalid-token; the right one connects', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const bad = ['dev:alice:admin', 'dev:wrong-secret-0123456789abc:alice:admin', 'dev:test-secret-0123456789abcdef:alice:owner'].map((t) => { const c = connect(wsUrl(s.port), page, t); clients.push(c); return c; });
    await Promise.all(bad.map((c) => eventually(() => (c.failures.length > 0 ? true : undefined), 5000, 'refused')));
    expect(bad.map((c) => c.failures[0])).toEqual(['invalid-token', 'invalid-token', 'invalid-token']);
    const good = connect(wsUrl(s.port), page, 'dev:test-secret-0123456789abcdef:alice:admin'); clients.push(good);
    await synced(good);
  });
});

describe('global cap on unauthenticated sockets', () => {
  it('past GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS new unauthenticated upgrades from any address get 503 with Retry-After; an authenticated user still connects once a slot is free', async () => {
    const s = await start({ GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS: '3' });
    const open: Probe[] = [];
    for (let i = 0; i < 3; i += 1) { const p = await upgrade(s.port, good, `127.0.0.${String(i + 2)}`); expect(p.status).toBe(101); open.push(p); }
    expect(await retryAfter(s.port, good)).toBe('5');
    expect((await upgrade(s.port, good, '127.0.0.9')).status).toBe(503);
    open[0]?.close();
    const page = newPage(); await seedPage(DB, page);
    // Until the server handles that close the upgrade gets 503 and the provider retries on its own; it syncs once the slot is free.
    const c = connect(wsUrl(s.port), page); clients.push(c);
    await eventually(() => (c.provider.synced ? true : undefined), 10_000, 'synced'); // authenticated sockets never count against the cap
    open.forEach((p) => { p.close(); });
  });
});

// Product behaviour shown here: from ONE address only 10 not-yet-signed-in sockets are allowed at a time (GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS), so an office of 100
// behind one address is admitted in waves, by the client's own retry after a refusal, all within a few seconds. Each client waits with the budget stated by the test, not the 5 s
// default of the helper: all the waits start at the same moment, and the time to admit the last one depends on the machine.
const OFFICE_BUDGET_MS = 30_000;
/** Waits for every client to sync within the office budget; returns when each synced (first, median, p90, last) and how many were refused at least once. */
async function syncAll(cs: ReturnType<typeof connect>[]): Promise<string> {
  const t0 = Date.now();
  const times: number[] = [];
  await Promise.all(cs.map((c) => eventually(() => (c.provider.synced ? true : undefined), OFFICE_BUDGET_MS, 'provider synced').then(() => { times.push(Date.now() - t0); })));
  times.sort((x, y) => x - y);
  const at = (q: number): number => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0;
  const line = `office sync: ${String(cs.length)} clients, first ${String(times[0])} ms, median ${String(at(0.5))} ms, p90 ${String(at(0.9))} ms, last ${String(times.at(-1))} ms, refused at least once ${String(cs.filter((c) => c.closes.length > 0 || c.failures.length > 0).length)}`;
  process.stdout.write(`\n${line}\n`);
  expect(times.at(-1) ?? Number.POSITIVE_INFINITY).toBeLessThan(OFFICE_BUDGET_MS);
  return line;
}

describe('an office behind one address (R4.19, R12.28)', () => {
  it('100 users with valid tokens open 3 pages each within a minute from one address: all 300 sync', async () => {
    const s = await start();
    const pages = [newPage(), newPage(), newPage()];
    for (const p of pages) await seedPage(DB, p);
    const cs = pages.flatMap((p) => Array.from({ length: 100 }, (_, i) => connect(wsUrl(s.port), p, `dev:test-secret-0123456789abcdef:user${String(i)}:member`)));
    clients.push(...cs);
    await syncAll(cs);
  }, 120_000);

  it('100 simultaneous reconnects from one address all sync', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const cs = Array.from({ length: 100 }, (_, i) => connect(wsUrl(s.port), page, `dev:test-secret-0123456789abcdef:user${String(i)}:member`));
    clients.push(...cs);
    await syncAll(cs);
  }, 120_000);
});

describe('unauthenticated sockets per address (R12.28)', () => {
  it('the 11th socket that never authenticates is refused with 429 and a short Retry-After, not counted; closing one frees a slot', async () => {
    const s = await start();
    const open: Probe[] = [];
    for (let i = 0; i < 10; i += 1) { const p = await upgrade(s.port, good); expect(p.status).toBe(101); open.push(p); }
    expect(await retryAfter(s.port, good)).toBe('2');
    open[0]?.close();
    // Refused upgrades are not counted: retry until the server has handled the close and the slot is free.
    const again = await eventually(async () => { const p = await upgrade(s.port, good); return p.status === 101 ? p : undefined; }, 5000, 'a slot freed');
    expect(again.status).toBe(101);
    open.push(again);
    open.forEach((p) => { p.close(); });
  });
});
