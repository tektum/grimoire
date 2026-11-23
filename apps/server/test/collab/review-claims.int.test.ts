import { randomUUID } from 'node:crypto';
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
      const seen: string[] = []; // what each provider was told, in order: the evidence if an admitted document loses its authentication
      shared.on('close', ({ event }: { event: { code: number } }) => { seen.push(`socket closed ${String(event.code)}`); });
      for (const [i, page] of pages.slice(0, 2).entries()) {
        const p = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: page, token: token('alice'),
          onAuthenticationFailed: ({ reason }) => { seen.push(`doc${String(i)} permission denied: ${reason}`); },
          onClose: ({ event }) => { seen.push(`doc${String(i)} closed ${String(event.code)} ${event.reason}`); } });
        admitted.push(p); p.attach();
        await eventually(() => (p.isAuthenticated ? true : undefined), 5000, 'authenticated');
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
      // On a failure the evidence is in the message: which admitted document lost its authentication, and what the server logged about connections and limits.
      const states = admitted.map((p, i) => `doc${String(i)}: authenticated=${String(p.isAuthenticated)} synced=${String(p.synced)}`).join('; ');
      const connectionEvents = server.events.filter((e) => /socket|connection|limit|upgrade|close|refus|connected/.test(String(e['event']))).map((e) => `${String(e['event'])}:${String(e['limit'] ?? e['code'] ?? e['reason'] ?? '')}@${String(e['pageId'] ?? '').slice(0, 4)}`).join(', ');
      expect(admitted.every((p) => p.isAuthenticated), `${states} | client saw: ${seen.join('; ')} | server: ${connectionEvents}`).toBe(true);
      // The third document was refused for the right reason: the server counted a per-user document limit (not some unrelated failure).
      expect(server.events.some((e) => e['event'] === 'collab.limit_hit' && e['limit'] === 'user-documents')).toBe(true);
      for (const p of [...admitted, third, w]) p.destroy();
      shared.destroy();
    } finally { await server.kill(); }
  }, 60_000);
});

describe('the per-user document cap when the documents of one socket open at the same moment', () => {
  // Forced interleaving (no awaiting between the attaches): three documents of one user race for a cap of two on ONE socket, so a refusal arrives while the other
  // documents are still authenticating. Whatever the order, exactly two are admitted, one is refused, and the shared socket is never closed as a whole.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('three documents attached in the same tick, cap of two: two stay authenticated and edit, one is refused, the socket stays open (round %i)', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: '2', GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '5' } });
    const providers: HocuspocusProvider[] = [];
    const refused = new Set<string>();
    let socketCloses = 0;
    let shared: HocuspocusProviderWebsocket | undefined;
    let w: HocuspocusProvider | undefined;
    try {
      shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      shared.on('close', () => { socketCloses += 1; });
      for (const page of pages.slice(0, 3)) {
        const p = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: page, token: token('alice'), onClose: () => { refused.add(page); }, onAuthenticationFailed: () => { refused.add(page); } });
        providers.push(p); p.attach();
      }
      await eventually(() => (server.events.some((e) => e['event'] === 'collab.limit_hit' && e['limit'] === 'user-documents') ? true : undefined), 10_000, 'one document is refused');
      // The refused document is told so over the socket, a different channel from the server's log: count it once the client has been told (a close, or a permission-denied),
      // and only then the documents that stay (until a refusal is delivered, the client still counts the doomed document as authenticated).
      await eventually(() => (refused.size === 1 ? true : undefined), 10_000, 'the client is told which document is refused');
      await eventually(() => (providers.filter((p) => p.isAuthenticated && p.synced).length === 2 ? true : undefined), 10_000, 'the two other documents are authenticated and synced');
      const kept = providers.filter((p) => p.isAuthenticated && p.synced);
      const watcher = new Y.Doc();
      w = new HocuspocusProvider({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN), document: watcher, name: kept[0]!.configuration.name, token: token('bob') });
      await eventually(() => (w.synced ? true : undefined), 5000, 'watcher synced');
      const mark = `still here ${randomUUID()}`; // unique per round: the pages are shared by every round and by the earlier test, so a fixed text could already be there
      kept[0]!.document.getText('prosemirror').insert(0, mark);
      await eventually(() => (watcher.getText('prosemirror').toString().includes(mark) ? true : undefined), 5000, 'an admitted document still edits');
      const limitHits = server.events.filter((e) => e['event'] === 'collab.limit_hit' && e['limit'] === 'user-documents').length;
      expect(limitHits, 'exactly one refusal').toBe(1);
      expect(providers.filter((p) => p.isAuthenticated).length, 'the two admitted documents are still authenticated').toBe(2);
      expect(socketCloses, 'the shared socket was never closed').toBe(0);
    } finally {
      for (const p of [...providers, ...(w ? [w] : [])]) p.destroy(); // on every path, so a failed check leaves no provider or socket behind
      shared?.destroy();
      await server.kill();
    }
  }, 60_000);
});

describe('per-user admission follows arrival order with the real server and a page that loads slowly', () => {
  const SLOW_MS = 1_500;
  const slowServer = (cap: string) => startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER: cap, GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER: '5', GRIMOIRE_TEST_SLOW_LOAD: `${pages[1] as string}:${String(SLOW_MS)}` } });
  const attach = (shared: HocuspocusProviderWebsocket, page: string, user = 'alice') => {
    let everAuthenticated = false; let denied: string | undefined;
    const p = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: page, token: token(user), onAuthenticated: () => { everAuthenticated = true; }, onAuthenticationFailed: ({ reason }) => { denied = reason; } });
    p.attach();
    return { p, everAuthenticated: () => everAuthenticated, denied: () => denied };
  };

  it('the only admitted document of a socket is still loading and a second document of the socket is refused: the socket stays open and the first document syncs', async () => {
    const server = await slowServer('1');
    try {
      const shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      const closes: number[] = [];
      shared.on('close', ({ event }: { event: { code: number } }) => { closes.push(event.code); });
      const slow = attach(shared, pages[1] as string); // takes 1.5 s to load: admitted, not connected
      await eventually(() => (slow.p.isAuthenticated ? true : undefined), 5000, 'the slow page told authenticated on arrival');
      const refused = attach(shared, pages[0] as string);
      await eventually(() => refused.denied(), 5000, 'the second document refused');
      await new Promise((resolve) => setTimeout(resolve, 700)); // past the 250 ms refusal close, before the slow load ends
      expect(closes, 'the socket was not closed while its admitted document loads').toEqual([]);
      await eventually(() => (slow.p.synced ? true : undefined), 10_000, 'the slow page synced once loaded');
    } finally {
      await server.kill();
    }
  }, 60_000);

  it('cap of two, the second page slow to load: the third document is the one refused, at once and without ever being told it is authenticated; the first two stay and edit', async () => {
    const server = await slowServer('2');
    try {
      const shared = new HocuspocusProviderWebsocket({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      const first = attach(shared, pages[0] as string);
      await eventually(() => (first.p.isAuthenticated ? true : undefined), 5000, 'first authenticated');
      const second = attach(shared, pages[1] as string); // its page takes 1.5 s to load
      await eventually(() => (second.p.isAuthenticated ? true : undefined), 5000, 'second told authenticated on arrival, while its page still loads');
      const third = attach(shared, pages[2] as string);
      const refusedAt = Date.now();
      await eventually(() => third.denied(), 5000, 'the third refused');
      expect(Date.now() - refusedAt, 'refused on arrival, not after the slow page finished loading').toBeLessThan(SLOW_MS);
      expect(third.denied()).toBe('full-for-you');
      await eventually(() => (second.p.synced ? true : undefined), 10_000, 'second synced once loaded');
      expect(third.everAuthenticated()).toBe(false);
      expect(first.p.isAuthenticated && second.p.isAuthenticated).toBe(true);
      const watcher = new Y.Doc();
      const w = new HocuspocusProvider({ url: wsUrl(server.port), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN), document: watcher, name: pages[1] as string, token: token('bob') });
      await eventually(() => (w.synced ? true : undefined), 5000, 'watcher synced');
      const mark = `slow page edit ${randomUUID()}`;
      second.p.document.getText('prosemirror').insert(0, mark);
      await eventually(() => (watcher.getText('prosemirror').toString().includes(mark) ? true : undefined), 5000, 'an edit of the slow, admitted document reaches another client');
      for (const x of [first.p, second.p, third.p, w]) x.destroy();
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

