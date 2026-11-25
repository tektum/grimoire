import { afterAll, describe, expect, it, vi } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { authOnlyFrame } from './limits-support.js';
import { ALLOWED_ORIGIN, newPage, seedPage, wsUrl } from './support.js';

const DB = `grimoire_m3t01b_preauth_${String(process.pid)}`;
const page = newPage();
const sockets: WebSocket[] = [];
let lastOpened = 0;
let lastClosed = 0;

const closeCodes: number[] = [];

function at(index: number): WebSocket {
  const address = `203.0.${String(Math.floor(index / 10) + 1)}.${String(index % 10 + 1)}`;
  class Forwarded extends WebSocket { constructor(url: string | URL) { super(url, { headers: { Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': address } }); } }
  const socket = new Forwarded(wsUrl(server.port));
  socket.addEventListener('open', () => { lastOpened = Date.now(); });
  socket.addEventListener('close', (e) => { closeCodes.push(e.code); lastClosed = Date.now(); });
  sockets.push(socket);
  return socket;
}

function open(index: number): Promise<void> {
  const socket = at(index);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => { resolve(); }, { once: true });
    socket.addEventListener('error', () => { reject(new Error('unauthenticated socket open failed')); }, { once: true });
  });
}

function onOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => { socket.addEventListener('open', () => { resolve(); }, { once: true }); });
}

// Set-up at module level (top-level await): `server` is a constant, never undefined, so no test needs an assertion or a getter.
requireBuild(); await createTestDatabase(DB, true); await seedPage(DB, page);
const server: ServerProcess = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_TRUSTED_PROXY: '127.0.0.1' } });
afterAll(async () => { for (const s of sockets) s.close(); await server.kill(); await dropTestDatabase(DB); });

describe('pre-sign-in slot lifetime (U1)', () => {
  it('500 idle sockets release by 6.5 seconds, replacement connects, and 4-second link stays for 30 seconds', async () => {
    await Promise.all(Array.from({ length: 500 }, (_, i) => open(i)));
    expect(sockets.every((s) => s.readyState === WebSocket.OPEN)).toBe(true);
    // The bound is on the server's release of the slots, so it is read from the server's own events (their time is the server's clock), not from when this test's client noticed the
    // closes: on a loaded runner the client sees 500 close frames late, and opening 500 sockets takes this process a while too. The client only has to see them, within a wait that
    // is not the measure.
    await vi.waitFor(() => { expect(sockets.every((s) => s.readyState === WebSocket.CLOSED)).toBe(true); }, { timeout: 20_000, interval: 10 });
    expect(closeCodes).toHaveLength(500);
    expect(new Set(closeCodes)).toEqual(new Set([4408])); // the contract's timeout code, not a bare reset
    await vi.waitFor(() => { expect(server.events.filter((e) => e.event === 'collab.refused' && e.code === 'preauth-timeout')).toHaveLength(500); }, { timeout: 10_000, interval: 10 });
    const released = server.events.filter((e) => e.event === 'collab.refused' && e.code === 'preauth-timeout').map((e) => Date.parse(String(e.ts)));
    const lastRelease = Math.max(...released);
    const timeline = `server released ${String(released.length)} slots; last release ${String(lastRelease - lastOpened)} ms after the last socket opened (first ${String(Math.min(...released) - lastOpened)} ms); this client saw the last close ${String(lastClosed - lastOpened)} ms after it`;
    expect(lastRelease - lastOpened, timeline).toBeLessThan(6500);
    const last = server.events.filter((e) => e.event === 'server.stats' && e.openUnauthenticated === 0).at(-1);
    expect(last, timeline).toBeDefined();
    const replacement = new WebSocket(wsUrl(server.port), { headers: { Origin: ALLOWED_ORIGIN } }); sockets.push(replacement);
    await onOpen(replacement); replacement.send(authOnlyFrame(page, 'dev:test-secret-0123456789abcdef:bob:member'));
    await vi.waitFor(() => { expect(server.events.some((e) => e.event === 'collab.connected' && e.pageId === page)).toBe(true); }, { timeout: 2000 });
    const authenticated = new WebSocket(wsUrl(server.port), { headers: { Origin: ALLOWED_ORIGIN } }); sockets.push(authenticated);
    await onOpen(authenticated);
    // Negative wait on the child server's real 4 s clock: an idle link that has not signed in must still be open after 4 s; no event marks "nothing happened".
    await new Promise<void>((resolve) => { setTimeout(resolve, 4000); });
    expect(authenticated.readyState).toBe(WebSocket.OPEN);
    authenticated.send(authOnlyFrame(page, 'dev:test-secret-0123456789abcdef:alice:member'));
    await new Promise<void>((resolve) => { authenticated.addEventListener('message', () => { resolve(); }, { once: true }); });
    // Negative wait, mandated by the 30 s connected-window requirement: a signed-in socket must still be open after 30 real seconds; the clock cannot be faked in a child server process.
    await new Promise<void>((resolve) => { setTimeout(resolve, 30000); });
    expect(authenticated.readyState).toBe(WebSocket.OPEN);
  }, 45_000);
});
