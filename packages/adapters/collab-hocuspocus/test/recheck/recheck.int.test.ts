import { afterEach, describe, expect, it } from 'vitest';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { ALLOWED_ORIGIN, originSocket } from '@tektum/grimoire-test-support';
import type { VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { connect, eventually, startLive } from '../host/live-support.js';
import type { Client, Live } from '../host/live-support.js';
import { PAGE, SUBJECT, U1 } from '../host/support.js';

// The re-check on a real socket and the real Hocuspocus server, over fake stores, a 1-second interval and real timers. The clock is the
// fake one of the deps: a test moves it to make a session expire, and the next real tick (at most one second later) acts on it.
const PAGE_B = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11';
const lives: Live[] = [];
const clients: { destroy(): void }[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

/** Tokens are `<subject>` (valid for an hour on the fake clock) or `<subject>@<expiresAtMs>`. */
async function live(): Promise<Live> {
  const l = await startLive('member', {}, (t) => {
    t.deps = { ...t.deps, config: makeFakeConfig({ collab: { recheckSeconds: 1 } }) };
    t.verifier.verify = (token: string): Promise<VerifyResult> => {
      t.verifier.calls++;
      const [subject = '', at] = token.split('@');
      return Promise.resolve({ kind: 'ok', userId: subject, expiresAt: at === undefined ? t.clock.now() + 3_600_000 : Number(at) });
    };
    void t.users.createIfAbsent({ descopeUserId: 'u2', email: 'u2@example.test', name: 'u2', role: 'member' });
  });
  lives.push(l);
  l.t.pages.seed(PAGE);
  l.t.pages.seed(PAGE_B);
  return l;
}
const open = (l: Live, subject: string, onStateless?: (p: string) => void): Client => {
  const c = connect(l, PAGE, subject, { maxAttempts: 1, ...(onStateless ? { onStateless } : {}) });
  clients.push(c);
  return c;
};
const serverText = (l: Live): string => l.host.hocuspocus?.documents.get(PAGE)?.getText('prosemirror').toString() ?? '';
const authed = (c: Client): Promise<true> => eventually(() => c.provider.isAuthenticated, 5000, 'authenticated');

describe('peer registry, on a real socket: closing by user id closes exactly that user\'s documents', () => {
  it('one socket, two documents, two users: the first user is closed, the second user\'s document and the socket stay', async () => {
    const l = await live();
    const u2 = await l.t.idOf('u2');
    const shared = new HocuspocusProviderWebsocket({ url: l.url, WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
    clients.push({ destroy: () => { shared.destroy(); } });
    const closed: Record<string, string[]> = { a: [], b: [] };
    const make = (name: string, token: string, key: string): HocuspocusProvider => {
      const p = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name, token, onClose: ({ event }) => { closed[key]?.push(event.reason); } });
      p.attach();
      clients.push({ destroy: () => { p.destroy(); } });
      return p;
    };
    const a = make(PAGE, SUBJECT, 'a');
    const b = make(PAGE_B, 'u2', 'b');
    await eventually(() => a.isAuthenticated && b.isAuthenticated, 5000, 'both documents authenticated');
    expect(u2).toBeDefined();
    await l.host.closeConnections({ userId: U1 });
    await eventually(() => closed['a']?.length, 5000, 'first user closed');
    expect(closed['b']).toEqual([]);
    expect(b.isAuthenticated).toBe(true);
    expect(shared.webSocket?.readyState).toBe(1);
  });
});

describe('the re-check on the real server (1 s interval)', () => {
  it('a suspended user is closed within the interval; the other user on the same page is not', async () => {
    const l = await live();
    const a = open(l, SUBJECT); const b = open(l, 'u2');
    await authed(a); await authed(b);
    const reasons: string[] = [];
    a.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
    l.t.users.suspend(SUBJECT);
    await eventually(() => reasons.length > 0, 4000, 'closed by the re-check');
    expect(reasons).toEqual(['access-changed']);
    expect(b.provider.isAuthenticated).toBe(true);
  });

  it('lowered to read: closed access-changed; edits sent through the whole sequence never land; the reconnect is read-only', async () => {
    const l = await live();
    const a = open(l, SUBJECT);
    const w = open(l, 'u2');
    await authed(a); await authed(w);
    const reasons: string[] = [];
    a.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
    a.text.insert(0, 'before;');
    await eventually(() => serverText(l).includes('before;'), 4000, 'a write lands while writable');
    await l.t.users.updateRole('legacy', U1, 'viewer');
    // the raw client keeps sending: an edit per poll, until the server has closed it, and afterwards
    await eventually(() => { a.text.insert(a.text.length, 'x;'); return reasons.length > 0; }, 4000, 'closed by the re-check');
    expect(reasons).toEqual(['access-changed']);
    const landed = serverText(l);
    for (let i = 0; i < 20; i++) a.text.insert(a.text.length, `late${String(i)};`);
    const again = open(l, SUBJECT);
    await authed(again);
    expect(again.provider.authorizedScope).toBe('readonly');
    again.text.insert(0, 'ro-edit;');
    w.text.insert(0, 'W-marker;');
    await eventually(() => again.text.toString().includes('W-marker;'), 4000, 'reading continues after the reconnect');
    expect(serverText(l)).not.toContain('late');
    expect(serverText(l)).not.toContain('ro-edit');
    expect(landed).toContain('before;');
  });

  it('a session that expires and is not renewed is closed 4401 session-expired', async () => {
    const l = await live();
    const stale = open(l, `${SUBJECT}@${String(l.t.clock.now() + 30_000)}`); // the token of a connection is a constant: the answer to a token request is the same, expired one
    const other = open(l, 'u2');
    await authed(stale); await authed(other);
    const reasons: string[] = [];
    stale.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
    l.t.clock.advance(31_000);
    await eventually(() => reasons.length > 0, 4000, 'expired session closed');
    expect(reasons).toEqual(['session-expired']);
    expect(other.provider.isAuthenticated).toBe(true);
  });

  it('a session that is renewed on the open connection (the provider answers the server\'s token request) is kept past its first expiry', async () => {
    const l = await live();
    let expiresAt = l.t.clock.now() + 30_000;
    const c = connect(l, PAGE, () => `${SUBJECT}@${String(expiresAt)}`, { maxAttempts: 1 });
    clients.push(c);
    await authed(c);
    expiresAt = l.t.clock.now() + 3_600_000; // what the client's token function returns from now on
    const asked = l.t.verifier.calls;
    l.t.clock.advance(29_000); // within two intervals of the end: the next round asks for a token
    await eventually(() => l.t.verifier.calls > asked, 4000, 'the fresh token was presented and verified');
    const rounds = l.t.accessStore.calls;
    l.t.clock.advance(10_000); // past the first expiry
    await eventually(() => l.t.accessStore.calls >= rounds + 2, 5000, 'two more rounds ran');
    expect(c.provider.isAuthenticated).toBe(true);
    expect(c.closes).toEqual([]);
  });

  it('after shutdown no round runs', async () => {
    const l = await live();
    const a = open(l, SUBJECT);
    await authed(a);
    await l.host.shutdown({ deadlineMs: 500 });
    const calls = l.t.accessStore.calls;
    l.t.users.suspend(SUBJECT);
    l.t.clock.advance(10_000);
    await new Promise<void>((r) => { setImmediate(r); });
    expect(l.t.accessStore.calls).toBe(calls);
  });
});
