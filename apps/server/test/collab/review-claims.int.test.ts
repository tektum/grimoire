import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { appUrl, createTestDatabase, dropTestDatabase, freePort, requireBuild, startServer } from '../server/support/harness.js';
import { RawClient, syncUpdateFrame } from './limits-support.js';
import { eventually, newPage, originSocket, seedPage, wsUrl, ALLOWED_ORIGIN } from './support.js';

// Review claims about the collaboration host's limits, each shown against the real server (not a fake connection).
const DB = `grimoire_review_claims_${String(process.pid)}`;
const pages = Array.from({ length: 6 }, newPage);
const token = (user: string) => `dev:test-secret-0123456789abcdef:${user}:member`;

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); for (const page of pages) await seedPage(DB, page); }, 60_000);
afterAll(() => dropTestDatabase(DB));

describe('a document refused for a per-user cap does not take the admitted documents of the same socket with it', () => {
  it('two admitted documents on one socket keep working when a third on that socket is refused full-for-you', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: '2', GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '5' } });
    try {
      const shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      const admitted: HocuspocusProvider[] = [];
      for (const page of pages.slice(0, 2)) {
        const p = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: page, token: token('alice') });
        admitted.push(p); p.attach();
        await eventually(() => (p.isAuthenticated ? true : undefined), 5000, 'admitted');
      }
      const refusals: string[] = [];
      const third = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: pages[2] as string, token: token('alice'), onAuthenticationFailed: ({ reason }) => { refusals.push(`auth:${reason}`); }, onClose: ({ event }) => { refusals.push(`close:${String(event.code)}`); } });
      third.attach();
      // The refusal is awaited by the server's own limit event (the provider's close and failure callbacks are not a reliable signal of it).
      await eventually(() => (server.events.some((e) => e['event'] === 'collab.limit_hit' && e['limit'] === 'user-documents') ? true : undefined), 10_000, 'the third document is refused');
      // The admitted documents are still connected, and an edit on one still reaches the server (a second client sees it).
      const watcher = new Y.Doc();
      const w = new HocuspocusProvider({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN), document: watcher, name: pages[0] as string, token: token('bob') });
      await eventually(() => (w.synced ? true : undefined), 5000, 'watcher synced');
      admitted[0]?.document.getText('prosemirror').insert(0, 'still here');
      await eventually(() => (watcher.getText('prosemirror').toString().includes('still here') ? true : undefined), 5000, 'the admitted document still edits');
      expect(admitted.every((p) => p.isAuthenticated)).toBe(true);
      // The third document was refused for the right reason: the server counted a per-user document limit (not some unrelated failure).
      expect(server.events.some((e) => e['event'] === 'collab.limit_hit' && e['limit'] === 'user-documents')).toBe(true);
      for (const p of [...admitted, third, w]) p.destroy();
      shared.destroy();
    } finally { await server.kill(); }
  }, 60_000);
});

describe('a refused per-user byte budget tells the client why before the socket closes', () => {
  it('the flooding client receives the rate-limited notice and then the 4429 close', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_BYTES_PER_SECOND_PER_USER: '2000' } });
    try {
      const flood = await RawClient.open(wsUrl(server.port), pages[3] as string, token('mallory'));
      const update = (() => { const d = new Y.Doc(); let u = new Uint8Array(); d.on('update', (x: Uint8Array) => { u = x; }); d.getText('prosemirror').insert(0, 'a'.repeat(500)); return u; })();
      for (let i = 0; i < 40 && flood.closed === undefined; i++) flood.send(syncUpdateFrame(pages[3] as string, update));
      await eventually(() => flood.closed, 8000, 'flooder closed');
      expect(flood.closed?.code).toBe(4429);
      expect(flood.stateless.some((m) => m.includes('rate-limited'))).toBe(true);
    } finally { await server.kill(); }
  }, 60_000);
});

describe('connection caps hold when many sockets arrive at the same moment', () => {
  it('five simultaneous connections to one page with a per-page cap of two leave exactly two admitted', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: '2' } });
    try {
      const closed: boolean[] = Array.from({ length: 5 }, () => false);
      const providers = closed.map((_, i) => new HocuspocusProvider({
        url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN), document: new Y.Doc(), name: pages[4] as string, token: token(`racer${String(i)}`),
        onClose: () => { closed[i] = true; },
      }));
      // Every connection ends up admitted (authenticated and kept) or refused (closed): whatever the arrival order, the cap of two holds.
      await eventually(() => (providers.every((p, i) => (p.isAuthenticated && !closed[i]) || closed[i]) && closed.filter(Boolean).length >= 3 ? true : undefined), 10_000, 'the connections settle');
      expect(providers.filter((p, i) => p.isAuthenticated && !closed[i])).toHaveLength(2);
      for (const p of providers) p.destroy();
    } finally { await server.kill(); }
  }, 60_000);
});

describe('a graceful shutdown with clients connected on the second collaboration port', () => {
  it('exits 0 without a hook timeout: the sockets that were handed off by the upgrade are closed before the listener is waited for', async () => {
    const collabPort = await freePort();
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_PORT: String(collabPort) } });
    try {
      const client = await RawClient.open(wsUrl(collabPort), pages[5] as string, token('alice'));
      await eventually(() => (client.frames.length > 0 ? true : undefined), 8000, 'the client is connected and has been answered');
      const signalled = Date.now();
      server.signal('SIGTERM');
      const exit = await server.exited;
      const took = Date.now() - signalled;
      const phases = server.events.filter((e) => e['event'] === 'shutdown.hook_done').map((e) => `${String(e['hook'])}=${String(e['ms'])}ms`).join(' ');
      process.stdout.write(`SHUTDOWN took ${String(took)} ms: ${phases}\n`);
      expect(took, phases).toBeLessThan(12_000); // the non-save phases together are allowed 12 s (budget.ts); with nothing to save it takes a small part of that
      expect(server.events.filter((e) => e['event'] === 'shutdown.hook_timeout')).toEqual([]);
      expect(exit.code).toBe(0);
      client.close();
    } finally { await server.kill(); }
  }, 60_000);
});

describe('the first sign-ins of one new user arriving at the same moment', () => {
  it('are all admitted: provisioning the user row twice at once is not a refusal', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100' } });
    try {
      for (let round = 0; round < 6; round++) {
        const user = `newcomer${String(round)}x${String(Date.now() % 100000)}`;
        const clients = await Promise.all(pages.slice(0, 5).map((p) => RawClient.open(wsUrl(server.port), p, token(user))));
        await eventually(() => (clients.every((c) => c.frames.length > 0 || c.closed !== undefined) ? true : undefined), 10_000, 'every first sign-in is answered');
        expect(clients.flatMap((c) => (c.closed === undefined ? [] : [`${String(c.closed.code)} ${c.closed.reason}`]))).toEqual([]);
        for (const c of clients) c.close();
      }
    } finally { await server.kill(); }
  }, 120_000);
});

