import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, repoRoot, dropTestDatabase, get, requireBuild, sqlAdmin, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { waitUntil } from '@tektum/grimoire-test-support/harness';
import { ALLOWED_ORIGIN, connect, eventually, newPage, originSocket, pageRow, seedPage, sleep, synced, textOf, wsUrl } from './support.js';
import type { Client } from './support.js';

const DB = 'grimoire_t09_collab';
const running: ServerProcess[] = [];
const clients: Client[] = [];
const fast = { GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000' };
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...env } });
  running.push(s);
  return s;
}
const client = (s: ServerProcess, name: string, token?: string): Client => {
  const c = connect(wsUrl(s.port), name, token);
  clients.push(c);
  return c;
};
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);

/** Resolves with the HTTP status line of an upgrade request to `path`. */
function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, headers: { Origin: ALLOWED_ORIGIN, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
}, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await sqlAdmin(DB, 'grant update on pages to grimoire_app');
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('one process, one port', () => {
  it('two clients converge, a third joining later receives the state; /healthz and /readyz answer while sockets are open; other paths are 404', async () => {
    const s = await start(fast);
    const page = newPage(); await seedPage(DB, page);
    const a = client(s, page); const b = client(s, page);
    await Promise.all([synced(a), synced(b)]);
    a.text.insert(0, 'hello ');
    await eventually(() => (b.text.toString() === 'hello ' ? true : undefined), 3000, 'b sees a');
    b.text.insert(b.text.length, 'world');
    await eventually(() => (a.text.toString() === 'hello world' ? true : undefined), 3000, 'a sees b');
    const c = client(s, page); await synced(c);
    expect(c.text.toString()).toBe('hello world');
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
    expect(await get(`${s.url}/readyz`)).toEqual({ status: 200, body: 'ok' });
    expect(await upgradeStatus(s.port, '/elsewhere')).toBe(404);
    expect(events(s, 'collab.connected').length).toBeGreaterThanOrEqual(3);
  });

  it('GRIMOIRE_COLLAB_PORT serves /collab on that port and 404s on the main port; role api 404s', async () => {
    const { freePort } = await import('../server/support/harness.js');
    const second = await freePort();
    const s = await start({ ...fast, GRIMOIRE_COLLAB_PORT: String(second) });
    const page = newPage(); await seedPage(DB, page);
    expect(await upgradeStatus(s.port, '/collab')).toBe(404);
    const c = connect(wsUrl(second), page); clients.push(c);
    await synced(c);
    const api = await start({ GRIMOIRE_ROLE: 'api' });
    expect(await upgradeStatus(api.port, '/collab')).toBe(404);
    expect(await get(`${api.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
  });

  it('GRIMOIRE_LOCAL=0 with a project id starts with the Descope verifier: a development token is refused invalid-token', async () => {
    const s = await start({ GRIMOIRE_LOCAL: '0', GRIMOIRE_DEV_TOKEN_SECRET: '', GRIMOIRE_DESCOPE_PROJECT_ID: 'P2abc', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' });
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page, 'dev:test-secret-0123456789abcdef:alice:member');
    await eventually(() => (c.failures.length > 0 ? true : undefined), 5000, 'refused');
    expect(c.failures).toEqual(['invalid-token']);
    expect(s.output).not.toContain('test-secret-0123456789abcdef');
  });
});

describe('persistence', () => {
  it('after all clients leave the row holds the state, and a restarted server serves it', async () => {
    const s = await start(fast);
    const page = newPage(); await seedPage(DB, page);
    const a = client(s, page); const b = client(s, page);
    await Promise.all([synced(a), synced(b)]);
    a.text.insert(0, 'persisted ');
    b.text.insert(0, 'text');
    await eventually(() => (a.text.toString() === b.text.toString() && a.text.length === 14 ? true : undefined), 3000, 'converged');
    const expected = a.text.toString();
    a.destroy(); b.destroy();
    const row = await eventually(async () => { const r = await pageRow(DB, page); return r?.ydoc ? r : undefined; }, 5000, 'row stored');
    expect(textOf(row.ydoc)).toBe(expected);
    expect(row.ydoc_size).toBe(row.ydoc?.length);
    s.signal('SIGTERM'); await s.exited;
    const s2 = await start(fast);
    const c = client(s2, page); await synced(c);
    expect(c.text.toString()).toBe(expected);
  }, 30_000);

  it('a page edited once and left idle is stored within 10 s with the default debounce', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    const t0 = Date.now();
    c.text.insert(0, 'idle edit');
    const row = await eventually(async () => { const r = await pageRow(DB, page); return r?.ydoc ? r : undefined; }, 10_000, 'stored');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(textOf(row.ydoc)).toBe('idle edit');
  }, 20_000);

  it('continuous typing every 500 ms for 12 s produces a save before second 11 (maxDebounce)', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    const t0 = Date.now();
    // The typist against the child server's real clock: one character every 500 ms, so the 3 s debounce never elapses and only maxDebounce can cause the save.
    c.text.insert(c.text.length, 'x');
    const typing = setInterval(() => { c.text.insert(c.text.length, 'x'); }, 500);
    const firstSave = await eventually(async () => ((await pageRow(DB, page))?.ydoc ? Date.now() - t0 : undefined), 12_000, 'a save under continuous typing')
      .finally(() => { clearInterval(typing); });
    expect(firstSave).toBeLessThan(11_000);
  }, 30_000);

  it('SIGTERM with unsaved edits stores them before exit 0, and clients are closed with going-away (1001)', async () => {
    const s = await start(); // default debounce 3 s: the edit is still pending when the signal arrives
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    const raw = new (originSocket(ALLOWED_ORIGIN))(wsUrl(s.port));
    const rawClose = new Promise<number>((resolve) => { raw.onclose = (e) => { resolve(e.code); }; });
    await new Promise<void>((resolve) => { raw.onopen = () => { resolve(); }; });
    c.text.insert(0, 'unsaved at SIGTERM');
    await sleep(200);
    expect((await pageRow(DB, page))?.ydoc).toBeNull();
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(0);
    expect(textOf((await pageRow(DB, page))?.ydoc)).toBe('unsaved at SIGTERM');
    expect(await rawClose).toBe(1001);
    await eventually(() => (c.closes.includes(1001) ? true : undefined), 3000, 'the provider client observes close 1001 itself');
    await eventually(() => (c.provider.configuration.websocketProvider.status !== 'connected' ? true : undefined), 3000, 'provider disconnected');
  }, 30_000);
});

describe('refusals', () => {
  it('unknown page: not-found; bad token: invalid-token and the socket is closed within 1 s; the log names the refusals', async () => {
    const s = await start(fast);
    const unknown = client(s, newPage());
    await eventually(() => (unknown.failures.length ? true : undefined), 5000, 'refused');
    expect(unknown.failures[0]).toBe('not-found');
    const page = newPage(); await seedPage(DB, page);
    const bad = client(s, page, 'garbage');
    await eventually(() => (bad.failures.length ? true : undefined), 5000, 'refused');
    expect(bad.failures[0]).toBe('invalid-token');
    const t0 = Date.now();
    await eventually(() => (bad.closes.length ? true : undefined), 2000, 'closed');
    expect(Date.now() - t0).toBeLessThan(1000);
    const refused = events(s, 'collab.refused').map((e) => e['code']);
    expect(refused).toContain('not-found');
    expect(refused).toContain('invalid-token');
    expect(s.output).not.toContain('garbage');
  });

  it('bad document names are refused as bad-document-name', async () => {
    const s = await start(fast);
    for (const name of ['0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10', '0b6f4f0e3c1d4a539a625d1c2a7e8f10', '../x', 'a'.repeat(300), '{0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10}']) {
      const c = client(s, name);
      await eventually(() => (c.failures.length ? true : undefined), 5000, 'refused');
      expect(c.failures[0]).toBe('bad-document-name');
    }
  });

  it('viewer role: readonly scope, writes never reach the other client and the row stays unchanged for 5 s', async () => {
    const s = await start(fast);
    const page = newPage(); await seedPage(DB, page);
    const v = client(s, page, 'dev:test-secret-0123456789abcdef:vera:viewer'); const w = client(s, page);
    await Promise.all([synced(v), synced(w)]);
    expect(v.provider.authorizedScope).toBe('readonly');
    v.text.insert(0, 'viewer wrote this');
    // Negative over 5 s: the write reaches neither the other client (2 s) nor the row (5 s in all); either failing ends the wait at once.
    expect(await waitUntil(() => w.text.toString() !== '', 2000)).toBe(false);
    expect(w.text.toString()).toBe('');
    expect(await waitUntil(async () => Boolean((await pageRow(DB, page))?.ydoc), 3000)).toBe(false);
    expect((await pageRow(DB, page))?.ydoc).toBeNull();
  }, 20_000);
});

describe('store failures', () => {
  const retry = { ...fast, GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '100', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '300' };

  it('an unwritable table is retried, the alarm is logged once, and the latest text lands after the privilege returns', async () => {
    const s = await start(retry);
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    await sqlAdmin(DB, 'revoke update on pages from grimoire_app');
    c.text.insert(0, 'first');
    await eventually(() => (events(s, 'collab.store_failed').length >= 6 ? true : undefined), 15_000, 'failures');
    c.text.insert(c.text.length, ' second');
    expect(events(s, 'collab.store_alarm')).toHaveLength(1);
    await sqlAdmin(DB, 'grant update on pages to grimoire_app');
    await eventually(async () => ((await pageRow(DB, page))?.ydoc && textOf((await pageRow(DB, page))?.ydoc) === 'first second' ? true : undefined), 15_000, 'latest text stored');
    expect(JSON.stringify(events(s, 'collab.store_failed'))).not.toContain('first');
    expect(s.output).not.toContain('permission denied');
  }, 40_000);

  it('failures continuing at SIGTERM: exit 1 within the deadline, collab.store_abandoned per page', async () => {
    const s = await start({ ...retry, GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '2000', GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '1500', GRIMOIRE_SAVE_TIMEOUT_MS: '100' });
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    await sqlAdmin(DB, 'revoke update on pages from grimoire_app');
    c.text.insert(0, 'will be lost');
    await eventually(() => (events(s, 'collab.store_failed').length >= 2 ? true : undefined), 10_000, 'failures');
    const t0 = Date.now();
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(1);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(events(s, 'collab.store_abandoned')).toEqual([expect.objectContaining({ pageId: page })]);
  }, 40_000);
});

const declaredEvents = (): Set<string> => {
  const files = ['apps/server/src/events.ts', 'packages/adapters/collab-hocuspocus/src/events.ts'];
  return new Set(files.flatMap((f) => [...readFileSync(path.join(repoRoot, f), 'utf8').matchAll(/'([a-z_]+\.[a-z_]+)':/g)].map((m) => m[1] ?? '')));
};

describe('library output and unreadable state', () => {
  it('a failed store and a malformed document name produce only declared JSON events, and the raw name appears in no line', async () => {
    const s = await start({ GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000', GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '100', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '200' });
    const sentinel = 'RAW-NAME-SENTINEL-xyz';
    const bad = client(s, sentinel);
    await eventually(() => (bad.failures.length ? true : undefined), 5000, 'refused');
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    await sqlAdmin(DB, 'revoke update on pages from grimoire_app');
    c.text.insert(0, 'x');
    await eventually(() => (events(s, 'collab.store_failed').length >= 3 ? true : undefined), 10_000, 'failed stores');
    const declared = declaredEvents();
    const lines = s.output.split('\n').filter(Boolean);
    for (const l of lines) {
      const e = JSON.parse(l) as Record<string, unknown>; // every line is JSON
      expect(declared.has(String(e['event'])), `undeclared event in: ${l.slice(0, 120)}`).toBe(true);
    }
    expect(s.output).not.toContain(sentinel);
    expect(s.output).not.toContain('permission denied');
  }, 30_000);

  it('unreadable stored state: the client sees the documented close within 2 s, the server stays up, another page works, no hammering, nothing written', async () => {
    const s = await start(fast);
    const bad = newPage(); await seedPage(DB, bad);
    await sqlAdmin(DB, `update pages set ydoc = '\\xffffff09090909'::bytea, ydoc_size = 7 where id = '${bad}'`);
    const good = newPage(); await seedPage(DB, good);
    const c = client(s, bad);
    await eventually(() => (c.closes.length ? true : undefined), 2000, 'close');
    expect(c.closes[0]).toBe(4500);
    const g = client(s, good); await synced(g);
    // No hammering over 2.5 s: the refused client's reconnects stay at four state-corrupt refusals or fewer and nothing is stored.
    expect(await waitUntil(() => events(s, 'collab.refused').filter((e) => e['code'] === 'state-corrupt').length > 4 || events(s, 'collab.store_failed').length > 0, 2500)).toBe(false);
    expect(events(s, 'collab.refused').filter((e) => e['code'] === 'state-corrupt').length).toBeLessThanOrEqual(4);
    expect(events(s, 'collab.store_failed')).toHaveLength(0);
    expect((await pageRow(DB, bad))?.ydoc_size).toBe(7);
    expect(await get(`${s.url}/healthz`)).toEqual({ status: 200, body: 'ok' });
  }, 20_000);
});

