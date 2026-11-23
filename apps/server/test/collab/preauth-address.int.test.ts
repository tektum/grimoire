import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { authOnlyFrame } from './limits-support.js';
import { ALLOWED_ORIGIN, newPage, seedPage, wsUrl } from './support.js';

// Real clock, one address: the pre-sign-in rules of U1 together (10 per address, the 11th refused, a sign-in at 3 s keeps its socket, the rest close at 5 s with 4408,
// then the address can connect again). The fake-clock cases are in packages/adapters/collab-hocuspocus/test/upgrade/upgrade-guard.test.ts.
const DB = `grimoire_m3gaps_preauth_addr_${String(process.pid)}`;
const page = newPage();
const ADDRESS = '203.0.113.7';
const sockets: WebSocket[] = [];
const closes = new Map<WebSocket, number>();

requireBuild(); await createTestDatabase(DB, true); await seedPage(DB, page);
const server: ServerProcess = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_TRUSTED_PROXY: '127.0.0.1' } });
afterAll(async () => { for (const s of sockets) s.close(); await server.kill(); await dropTestDatabase(DB); });

function connect(): WebSocket {
  class Forwarded extends WebSocket { constructor(url: string | URL) { super(url, { headers: { Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': ADDRESS } }); } }
  const socket = new Forwarded(wsUrl(server.port));
  socket.addEventListener('close', (e) => { closes.set(socket, e.code); });
  sockets.push(socket);
  return socket;
}
const opened = (s: WebSocket): Promise<void> => new Promise((resolve) => { s.addEventListener('open', () => { resolve(); }, { once: true }); });

/** The upgrade of an eleventh socket, by hand so that the HTTP status of the refusal is visible. */
function upgradeStatus(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: '/collab', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': ADDRESS } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
}

describe('pre-sign-in rules for one address, real clock (U1)', () => {
  it('10 unauthenticated sockets fill the address, the 11th is refused 429, a sign-in at 3 s stays open, the other 9 close 4408 at 5 s, then a new connect succeeds', async () => {
    const start = Date.now();
    const ten = Array.from({ length: 10 }, connect);
    await Promise.all(ten.map(opened));
    expect(await upgradeStatus()).toBe(429);
    // The log line travels over the child's stdout, the 429 over a socket: wait for the event instead of reading it once.
    await vi.waitFor(() => { expect(server.events.some((e) => e.event === 'collab.upgrade_refused' && e.reason === 'unauthenticated-sockets')).toBe(true); }, { timeout: 2000 });

    // The rule's own 3 s (the sign-in comes before the 5 s default timeout); the server's clock is real and in a child process, so the test follows the wall clock.
    await vi.waitFor(() => { expect(Date.now() - start).toBeGreaterThanOrEqual(3000); }, { timeout: 4000, interval: 50 });
    const [signedIn, ...idle] = ten as [WebSocket, ...WebSocket[]];
    signedIn.send(authOnlyFrame(page, 'dev:test-secret-0123456789abcdef:alice:member'));
    await vi.waitFor(() => { expect(server.events.some((e) => e.event === 'collab.connected' && e.pageId === page)).toBe(true); }, { timeout: 2000 });

    await vi.waitFor(() => { expect(idle.every((s) => s.readyState === WebSocket.CLOSED)).toBe(true); }, { timeout: 4500, interval: 20 });
    expect(idle.map((s) => closes.get(s))).toEqual(Array.from({ length: 9 }, () => 4408));
    expect(signedIn.readyState).toBe(WebSocket.OPEN);

    expect(await upgradeStatus()).toBe(101);
  }, 20_000);
});
