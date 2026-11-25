import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, originSocket, ALLOWED_ORIGIN } from '@tektum/grimoire-test-support';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { Refusal } from '../../src/refusal.js';
import { PAGE } from './support.js';
import { startLive } from './live-support.js';
import type { Live } from './live-support.js';

const PAGES = [PAGE, '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11', '1c7e0f3a-5b2d-4e8f-8a11-9b3c4d5e6f70'];
const lives: Live[] = [];
const clients: { destroy(): void }[] = [];
afterEach(async () => { clients.splice(0).forEach((c) => { c.destroy(); }); await Promise.all(lives.splice(0).map((l) => l.stop())); });

/** A host with a per-user cap of two documents and the given pages loading slowly: the load of a page in `slow` waits for `release()`. */
async function host(slow: readonly string[], options: Parameters<typeof startLive>[1] = {}, cap = 2): Promise<{ l: Live; release: () => void }> {
  const l = await startLive('member', options, (t) => { Object.assign(t.deps, { config: makeFakeConfig({ collab: { maxDocumentsPerUser: cap } }) }); });
  lives.push(l);
  for (const page of PAGES) l.t.pages.seed(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const load = l.t.pages.load.bind(l.t.pages);
  l.t.pages.load = async (tenantId: string, id: string) => { if (slow.includes(id)) await held; return load(tenantId, id); };
  return { l, release };
}
const open = (l: Live, page: string) => {
  const c = connect(l.url, page, 't'); clients.push(c);
  let everAuthenticated = false;
  c.provider.on('authenticated', () => { everAuthenticated = true; });
  return { c, everAuthenticated: () => everAuthenticated };
};
/** Opens a page that is going to be refused and waits until the provider is told so (the host's own refusal log is throttled to one line per code and window). */
const refused = async (l: Live, page: string): Promise<void> => {
  const o = open(l, page);
  let denied = false;
  o.c.provider.on('authenticationFailed', () => { denied = true; });
  await vi.waitFor(() => { expect(denied, `${page} refused`).toBe(true); });
  o.c.destroy();
};
const limitHits = (l: Live): number => l.t.logger.entries.filter((e) => e.event === 'collab.limit_hit' && (e.fields as { limit?: string } | undefined)?.limit === 'user-documents').length;

describe('per-user admission follows ARRIVAL order, and is decided before a document is told it is authenticated', () => {
  it('cap of two, the second page slow to load: the third document is the one refused (it is never told authenticated); the first two stay authenticated, synced and editable', async () => {
    const { l, release } = await host([PAGES[1]!]);
    const first = open(l, PAGES[0]!);
    await vi.waitFor(() => { expect(first.c.provider.isAuthenticated).toBe(true); });
    const second = open(l, PAGES[1]!);
    await vi.waitFor(() => { expect(second.c.provider.isAuthenticated, 'admitted on arrival, while its page still loads').toBe(true); });
    const third = open(l, PAGES[2]!);
    await vi.waitFor(() => { expect(limitHits(l), 'the third is refused at once').toBe(1); });
    release();
    await vi.waitFor(() => { expect(second.c.provider.synced).toBe(true); });
    expect(third.everAuthenticated(), 'the refused document was never told it was authenticated').toBe(false);
    expect(third.c.provider.isAuthenticated).toBe(false);
    expect(first.c.provider.isAuthenticated).toBe(true);
    expect(second.c.provider.isAuthenticated).toBe(true);
    first.c.text.insert(0, 'a');
    second.c.text.insert(0, 'b');
    await vi.waitFor(() => { expect(first.c.provider.hasUnsyncedChanges).toBe(false); expect(second.c.provider.hasUnsyncedChanges).toBe(false); }); // the server took the edits of both admitted documents
    expect(limitHits(l)).toBe(1);
  });
});

// Every admission taken at arrival is given back on every path that does not end in a connected document: a leaked place would lock a user out after `cap` failed opens.
describe('an admission taken at arrival is released on every path that never connects (cap of one: the next open must still be admitted)', () => {
  const admitted = (l: Live, page: string) => {
    const o = open(l, page);
    return vi.waitFor(() => { expect(o.c.provider.isAuthenticated, `${page} authenticated`).toBe(true); });
  };

  it('a later hook refuses the document after the admission', async () => {
    // An extension below the auth extension (priority 1000) refuses page 1 in its own onAuthenticate: the admission was taken by then.
    const refuser = { extensionName: 'refuser', priority: 500, onAuthenticate: (d: { documentName: string }) => { if (d.documentName === PAGES[1]) throw new Refusal('forbidden'); return Promise.resolve(); } };
    const { l } = await host([], { extensions: [refuser] }, 1);
    for (let i = 0; i < 3; i++) await refused(l, PAGES[1]!);
    await admitted(l, PAGES[0]!); // three failed opens, and the one place of the user is still free
  });

  it('an extension with the SAME priority as the auth extension runs after it and refuses: the admission is given back (it is not a comparison of priorities)', async () => {
    const refuser = { extensionName: 'refuser-1000', priority: 1000, onAuthenticate: (d: { documentName: string }) => { if (d.documentName === PAGES[1]) throw new Refusal('forbidden'); return Promise.resolve(); } };
    const { l } = await host([], { extensions: [refuser] }, 1);
    for (let i = 0; i < 3; i++) await refused(l, PAGES[1]!);
    await admitted(l, PAGES[0]!);
  });

  it('the page load fails', async () => {
    const { l } = await host([], {}, 1);
    const load = l.t.pages.load.bind(l.t.pages);
    l.t.pages.load = (tenantId: string, id: string) => (id === PAGES[1] ? Promise.reject(new Error('database down')) : load(tenantId, id));
    for (let i = 0; i < 3; i++) await refused(l, PAGES[1]!);
    await admitted(l, PAGES[0]!);
  });

  it('the page is not found', async () => {
    const { l } = await host([], {}, 1);
    for (let i = 0; i < 3; i++) await refused(l, '2d8f0c1a-7b3e-4c5d-9e6f-0a1b2c3d4e5f');
    await admitted(l, PAGES[0]!);
  });

  it('two sockets open the SAME unloaded page and its load fails: the library answers the second open alone (no hook of ours runs for it), its place is held only until the TTL, with both sockets still open', async () => {
    // TTL = the conversion gate's wait (10 s) + the larger conversion limit + two store timeouts = 10,000 + 200 + 2 x 100 ms.
    const l = await startLive('member', {}, (t) => { Object.assign(t.deps, { config: makeFakeConfig({ collab: { maxDocumentsPerUser: 2, seedTimeoutMs: 200, reseedTimeoutMs: 200, storeTimeoutMs: 100 } }) }); });
    lives.push(l);
    for (const page of PAGES) l.t.pages.seed(page);
    let fail: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { fail = resolve; });
    const load = l.t.pages.load.bind(l.t.pages);
    l.t.pages.load = async (tenantId: string, id: string) => { if (id === PAGES[1]) { await gate; throw new Error('database down'); } return load(tenantId, id); };
    const denied = new Set<string>();
    const first = open(l, PAGES[1]!); first.c.provider.on('authenticationFailed', () => { denied.add('first'); });
    const second = open(l, PAGES[1]!); second.c.provider.on('authenticationFailed', () => { denied.add('second'); });
    // Both opens are admitted (told authenticated on arrival) and waiting for the one shared load.
    await vi.waitFor(() => { expect([first.everAuthenticated(), second.everAuthenticated()]).toEqual([true, true]); });
    fail();
    await vi.waitFor(() => { expect(denied.size, 'both opens refused').toBe(2); });
    // The first open's place was given back by the guard; the second one's is still held (nothing told us it ended), so the user has one place left.
    await admitted(l, PAGES[0]!);
    const over = open(l, PAGES[2]!);
    let overDenied = false;
    over.c.provider.on('authenticationFailed', () => { overDenied = true; });
    await vi.waitFor(() => { expect(overDenied, 'the cap holds while the place is held').toBe(true); });
    over.c.destroy();
    // After the TTL the place is back, with the first two sockets still open.
    l.t.clock.advance(10_399); // the TTL is 10,400 ms of the host's clock: one millisecond short, the place is still held
    const early = open(l, PAGES[2]!);
    let earlyDenied = false;
    early.c.provider.on('authenticationFailed', () => { earlyDenied = true; });
    await vi.waitFor(() => { expect(earlyDenied).toBe(true); });
    early.c.destroy();
    l.t.clock.advance(2);
    let back = false;
    for (let attempt = 0; attempt < 1 && !back; attempt++) {
      const again = open(l, PAGES[2]!);
      let refusedAgain = false;
      again.c.provider.on('authenticationFailed', () => { refusedAgain = true; });
      await vi.waitFor(() => { expect(again.everAuthenticated() || refusedAgain).toBe(true); });
      back = again.everAuthenticated();
      again.c.destroy();
    }
    expect(back, 'the place came back after the TTL').toBe(true);
  });

  // Not tested here, on purpose: a socket that closes while its page loads (the host still establishes the connection and its close releases it, so a host-level test passes even
  // without `abandonSocket`) and shutdown (nothing observable at this level). Both are guarded by the unit tests of `abandonSocket` and `onDestroy` in limits/per-user-limits.test.ts.
});

describe('extension names are unique', () => {
  it('an outside extension that carries the name of a built-in one is a configuration error when the host is built', async () => {
    await expect(startLive('member', { extensions: [{ extensionName: 'grimoire-auth', priority: 1000 }] })).rejects.toThrow(/duplicate extension name: grimoire-auth/);
    await expect(startLive('member', { extensions: [{ extensionName: 'x', priority: 1 }, { extensionName: 'x', priority: 2 }] })).rejects.toThrow(/duplicate extension name: x/);
    await expect(startLive('member', { extensions: [{ extensionName: 'grimoire-lifecycle', priority: 1 }] })).rejects.toThrow(/duplicate extension name: grimoire-lifecycle/);
  });
});


describe('a refusal closes the socket only when the socket holds nothing admitted', () => {
  const TOKEN = 'dev:test-secret-0123456789abcdef:alice:member';
  const setup = async (slow: string | undefined, cap: number, extra: { seedTimeoutMs?: number; reseedTimeoutMs?: number; storeTimeoutMs?: number } = {}) => {
    const l = await startLive('member', {}, (t) => { Object.assign(t.deps, { config: makeFakeConfig({ collab: { maxDocumentsPerUser: cap, ...extra } }) }); });
    lives.push(l);
    for (const page of PAGES) l.t.pages.seed(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const load = l.t.pages.load.bind(l.t.pages);
    l.t.pages.load = async (tenantId: string, id: string) => { if (id === slow) await held; return load(tenantId, id); };
    const socket = new HocuspocusProviderWebsocket({ url: l.url, WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
    const closes: number[] = [];
    socket.on('close', ({ event }: { event: { code: number } }) => { closes.push(event.code); });
    const provider = (page: string) => {
      const p = new HocuspocusProvider({ websocketProvider: socket, document: new Y.Doc(), name: page, token: TOKEN });
      const state = { denied: false, authenticated: false };
      p.on('authenticationFailed', () => { state.denied = true; });
      p.on('authenticated', () => { state.authenticated = true; });
      p.attach();
      clients.push({ destroy: () => { p.destroy(); } });
      return { p, state };
    };
    clients.push({ destroy: () => { socket.destroy(); } });
    return { l, release, closes, provider };
  };

  it('document A is admitted and still loading, document B is refused for the cap: the socket stays open, and A connects and can edit', async () => {
    const s = await setup(PAGES[0], 1);
    const a = s.provider(PAGES[0]!);
    await vi.waitFor(() => { expect(a.state.authenticated, 'A told authenticated on arrival, its load still waiting').toBe(true); });
    const b = s.provider(PAGES[1]!);
    await vi.waitFor(() => { expect(b.state.denied).toBe(true); });
    await new Promise((resolve) => setTimeout(resolve, 900)); // well past the 250 ms refusal close
    expect(s.closes, 'the socket was not closed').toEqual([]);
    s.release();
    await vi.waitFor(() => { expect(a.state.authenticated && a.p.synced).toBe(true); });
    a.p.document.getText('t').insert(0, 'x');
    expect(s.closes).toEqual([]);
  });

  it('a socket whose only open is refused is closed', async () => {
    const s = await setup(undefined, 1, {});
    const ok = connect(s.l.url, PAGES[2]!, TOKEN); clients.push(ok); // another socket of the same user takes the one place
    await vi.waitFor(() => { expect(ok.provider.isAuthenticated).toBe(true); });
    const b = s.provider(PAGES[1]!);
    await vi.waitFor(() => { expect(b.state.denied).toBe(true); });
    await vi.waitFor(() => { expect(s.closes.length).toBeGreaterThan(0); });
  });

  it('a socket whose only reservation expires is then closed', async () => {
    // Two pages, cap two: A is admitted and never finishes loading; the user's other socket fills the second place; B is refused.
    const s = await setup(PAGES[0], 2, { seedTimeoutMs: 200, reseedTimeoutMs: 200, storeTimeoutMs: 100 });
    const a = s.provider(PAGES[0]!);
    await vi.waitFor(() => { expect(a.state.authenticated).toBe(true); });
    const other = connect(s.l.url, PAGES[2]!, TOKEN); clients.push(other);
    await vi.waitFor(() => { expect(other.provider.isAuthenticated).toBe(true); });
    const b = s.provider(PAGES[1]!);
    await vi.waitFor(() => { expect(b.state.denied).toBe(true); });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(s.closes, 'held while A is reserved').toEqual([]);
    s.l.t.clock.advance(10_401); // the reservation expires
    await vi.waitFor(() => { expect(s.closes.length).toBeGreaterThan(0); });
  });
});
