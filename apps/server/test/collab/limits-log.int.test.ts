import http from 'node:http';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { editor, RawClient, syncUpdateFrame } from './limits-support.js';
import type { Editor } from './limits-support.js';
import { eventually, newPage, seedPage, wsUrl } from './support.js';

/** The log under attack: a flood costs a few lines whose counts add up, and alarms are never throttled. */
const DB = 'grimoire_t10_log';
const running: ServerProcess[] = [];
const editors: Editor[] = [];
const raws: RawClient[] = [];
const base = {
  GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000',
  GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '100000', GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100000',
};
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...base, ...env } });
  running.push(s);
  return s;
}
const lines = (s: ServerProcess, ...names: string[]) => s.events.filter((e) => names.includes(String(e['event'])));
/** Occurrences of `event` with key field `field` = `key`: lines logged plus the counts of the summary lines. */
const occurrences = (s: ServerProcess, event: string, field: string, key: string): number =>
  lines(s, event).filter((e) => e[field] === key).length
  + lines(s, 'collab.log_suppressed').filter((e) => e['suppressedEvent'] === event && e['variant'] === key).reduce((n, e) => n + Number(e['count']), 0);

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  editors.splice(0).forEach((e) => { e.destroy(); });
  raws.splice(0).forEach((r) => { r.close(); });
  await sqlAdmin(DB, 'grant update on pages to grimoire_app');
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

function badOrigin(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: '/collab', headers: { Origin: 'http://evil.test', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', () => { resolve(0); });
    req.end();
  });
}

describe('log volume', () => {
  it('5,000 upgrades with a bad Origin in 10 seconds: a handful of log lines whose counts add up to 5,000, and no address in them', async () => {
    const s = await start();
    const t0 = Date.now();
    let done = 0;
    await Promise.all(Array.from({ length: 50 }, async () => { while (done < 5000) { done++; await badOrigin(s.port); } }));
    expect(Date.now() - t0).toBeLessThan(10_000);
    // the window ends and the summary is written: the counts reach 5,000 only then
    await vi.waitFor(() => { expect(occurrences(s, 'collab.upgrade_refused', 'reason', 'origin')).toBe(5000); }, { timeout: 20_000, interval: 100 });
    expect(lines(s, 'collab.upgrade_refused', 'collab.log_suppressed').length).toBeLessThanOrEqual(6);
    expect(occurrences(s, 'collab.upgrade_refused', 'reason', 'origin')).toBe(5000);
    expect(JSON.stringify(lines(s, 'collab.upgrade_refused', 'collab.log_suppressed'))).not.toContain('127.0.0.1');
  }, 60_000);

  it('document-message floods: 21 flooding sockets cost a few lines whose counts add up to the sockets closed', async () => {
    const s = await start(); const id = newPage(); await seedPage(DB, id);
    const burst = (n: number): Uint8Array<ArrayBuffer>[] => {
      const local = new Y.Doc(); const out: Uint8Array<ArrayBuffer>[] = [];
      local.on('update', (u: Uint8Array) => { out.push(syncUpdateFrame(id, u)); });
      for (let i = 0; i < n; i++) local.getText('prosemirror').insert(i, 'f');
      return out;
    };
    const first = await RawClient.open(wsUrl(s.port), id); raws.push(first);
    for (const f of burst(6000)) { if (first.closed) break; first.send(f); }
    await eventually(() => first.closed, 10_000, 'first flooder closed');
    let closedWith4429 = 1; // the first flooder
    for (let i = 0; i < 20; i++) {
      const r = await RawClient.open(wsUrl(s.port), id); raws.push(r);
      for (const f of burst(400)) { if (r.closed) break; r.send(f); }
      await eventually(() => r.closed, 5000, 'refused socket closed');
      if (r.closed?.code === 4429) closedWith4429++;
    }
    await vi.waitFor(() => {
      expect(occurrences(s, 'collab.limit_hit', 'limit', 'message-rate')).toBe(closedWith4429);
      expect(occurrences(s, 'collab.refused', 'code', 'rate-limited')).toBe(closedWith4429);
    }, { timeout: 20_000, interval: 100 });
    expect(lines(s, 'collab.refused', 'collab.limit_hit', 'collab.log_suppressed').length).toBeLessThanOrEqual(12);
    expect(closedWith4429).toBeGreaterThan(10);
    expect(occurrences(s, 'collab.limit_hit', 'limit', 'message-rate')).toBe(closedWith4429);
    expect(occurrences(s, 'collab.refused', 'code', 'rate-limited')).toBe(closedWith4429);
  }, 120_000);

  it('an alarm (collab.store_alarm) is not throttled and still appears during a flood', async () => {
    const s = await start({ GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '100', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '300' });
    const id = newPage(); await seedPage(DB, id);
    const e = editor(wsUrl(s.port), id); editors.push(e);
    await eventually(() => (e.provider.synced ? true : undefined), 8000, 'synced');
    await sqlAdmin(DB, 'revoke update on pages from grimoire_app');
    e.text.insert(0, 'unsaved');
    for (let i = 0; i < 60; i++) { const r = await badOrigin(s.port); if (r === 0) break; }
    await eventually(() => (lines(s, 'collab.store_alarm').length > 0 ? true : undefined), 15_000, 'store alarm');
    expect(lines(s, 'collab.store_alarm')).toHaveLength(1);
    expect(lines(s, 'collab.store_failed').length).toBeGreaterThanOrEqual(5); // every failure still logged
    expect(lines(s, 'collab.upgrade_refused').length).toBeLessThanOrEqual(2);
  }, 60_000);
});
