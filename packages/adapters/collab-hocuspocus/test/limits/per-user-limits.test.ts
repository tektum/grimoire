import { describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { frame, harness, pageName } from './support.js';
import type { Harness } from './support.js';

/** What Hocuspocus does per document connection: a `connected` hook with the verified user in the context, and a close that runs the registered callbacks once. */
function session(h: Harness, userId: string, socketId: string, page: number, opts: { gone?: boolean } = {}) {
  const name = pageName(page);
  const document = h.documents.get(name) ?? h.doc(name);
  h.documents.set(name, document);
  const closers: (() => void)[] = [];
  const base = h.conn(socketId, document);
  const connection = { ...base.connection, onClose: (fn: () => void) => { closers.push(fn); }, messageAddress: name };
  (document as unknown as { hasConnection: () => boolean }).hasConnection = () => !opts.gone;
  const connect = () => h.open({ documentName: name, socketId, context: { userId }, userId, connection });
  const config = {};
  return { base, config, connection, connect, close: () => { for (const f of closers.splice(0)) f(); } };
}

const documents = (h: Harness): number => (h.ext as unknown as { counts(): { documents: number } }).counts().documents;

describe('per-user caps on the limits extension', () => {
  it('refuses with the full-for-you reason and the BUSY close code, a fixed reason on the socket, and frees on close', async () => {
    const h = harness({ maxSocketsPerUser: 2, maxDocumentsPerUser: 3 });
    const live = [session(h, 'u', 's1', 1), session(h, 'u', 's1', 2), session(h, 'u', 's1', 3)];
    for (const s of live) await s.connect();
    const fourth = session(h, 'u', 's2', 4);
    await expect(fourth.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(fourth.base.closes).toEqual([]); // the refusal is the thrown reason: Hocuspocus answers permission-denied for this document and the host closes a socket with nothing else on it
    expect(h.limitHits().at(-1)).toEqual({ limit: 'user-documents', value: 3, max: 3 });
    await session(h, 'other', 's9', 4).connect(); // a second user still connects
    live[0]?.close();
    await expect(session(h, 'u', 's2', 4).connect()).resolves.toBeUndefined();
  });

  it('a connection that is already gone takes no place in the server or page counts: its close (onDisconnect) ran before `connected`, so only the user place is left to give back', async () => {
    const h = harness({ maxConnections: 1, maxConnectionsPerPage: 1 });
    const gone = session(h, 'u', 'sg', 1, { gone: true });
    h.ext.admit({ context: { peerId: 'g' }, socketId: 'sg', documentName: pageName(1), connectionConfig: gone.config }, 'u'); // the reservation made at arrival
    await h.disconnect(pageName(1), 'sg', 0, h.documents.get(pageName(1))); // the document's close, which uncounts the page and the socket
    await h.ext.connected?.({ documentName: pageName(1), socketId: 'sg', context: { userId: 'u', peerId: 'g' }, connectionConfig: gone.config, connection: gone.connection } as never);
    expect(documents(h)).toBe(0);
    await expect(session(h, 'v', 's2', 1).connect()).resolves.toBeUndefined(); // the one place is free
  });

  it('a refused document is refused at arrival whichever sockets carry its siblings, closes nothing itself, and takes no place', async () => {
    const h = harness({ maxDocumentsPerUser: 2 });
    const a = session(h, 'u', 's1', 1); const b = session(h, 'u', 's1', 2);
    await a.connect(); await b.connect();
    const third = session(h, 'u', 's1', 3);
    await expect(third.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(third.base.socketCloses).toEqual([]); // siblings on this socket: only the refused document is answered
    expect(third.base.closes).toEqual([]);
    const lone = session(h, 'u', 's2', 4);
    await expect(lone.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(lone.base.socketCloses).toEqual([]); // a socket with nothing else on it is closed by the peer registry after the refusal (peers.test.ts), not here
    expect((h.ext as unknown as { counts(): { documents: number } }).counts().documents).toBe(2); // the refused took no place
  });

  it('a connection that is already gone is never counted, and an unauthenticated context is not charged to anyone', async () => {
    const h = harness({ maxDocumentsPerUser: 1 });
    await session(h, 'u', 's1', 1, { gone: true }).connect();
    await expect(session(h, 'u', 's1', 2).connect()).resolves.toBeUndefined();
    expect((h.ext as unknown as { counts(): { documents: number } }).counts().documents).toBe(1);
  });

  it('the socket cap is per user: the same socket id under another user is separate', async () => {
    const h = harness({ maxSocketsPerUser: 1, maxDocumentsPerUser: 9 });
    await session(h, 'a', 's1', 1).connect();
    await expect(session(h, 'a', 's2', 2).connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    await expect(session(h, 'b', 's2', 2).connect()).resolves.toBeUndefined();
  });

  it('property: random connect, close, refusal and destroy interleavings for several users return every count to zero', async () => {
    let seed = 7;
    const r = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
    for (let round = 0; round < 15; round++) {
      const h = harness({ maxSocketsPerUser: 2, maxDocumentsPerUser: 4 });
      const counts = () => (h.ext as unknown as { counts(): { users: number; sockets: number; documents: number } }).counts();
      const open: ReturnType<typeof session>[] = [];
      const owner = new Map<ReturnType<typeof session>, string>();
      for (let step = 0; step < 120; step++) {
        const op = r(4);
        if (op < 2) {
          const user = `u${String(r(3))}`;
          const gone = r(8) === 0;
          const s = session(h, user, `${user}-s${String(r(3))}`, 1 + r(4), { gone });
          try { await s.connect(); open.push(s); if (!gone) owner.set(s, user); } catch { /* refused: nothing may stay counted */ }
        } else if (op === 2 && open.length > 0) {
          open.splice(r(open.length), 1)[0]?.close();
        } else if (open.length > 0) {
          for (const s of open.splice(0, r(open.length + 1))) s.close();
        }
        const perUser = (u: string) => open.filter((s) => owner.get(s) === u).length;
        for (const u of ['u0', 'u1', 'u2']) expect(perUser(u)).toBeLessThanOrEqual(4);
        expect(counts().documents).toBeLessThanOrEqual(open.length); // gone connections were never counted
      }
      for (const s of open) { s.close(); s.close(); }
      expect(counts()).toMatchObject({ users: 0, sockets: 0, documents: 0 });
    }
  });
});

describe('per-user byte budget on the limits extension', () => {
  it('refuses past the budget across pages with 4429, never charges another user, and counts frame bytes of the verified user', async () => {
    const clock = new FakeClock(0);
    const h = harness({ bytesPerSecondPerUser: 10 }, clock);
    const mine = [session(h, 'u', 's1', 1), session(h, 'u', 's1', 2)];
    for (const s of mine) await s.connect();
    const theirs = session(h, 'v', 's2', 1); await theirs.connect();
    const send = (s: ReturnType<typeof session>) => h.ext.beforeHandleMessage?.({ update: frame(0), socketId: s.base.connection.socketId, documentName: pageName(1), document: {}, connection: s.base.connection, context: { userId: s === theirs ? 'v' : 'u' } } as never);
    for (let i = 0; i < 2; i++) await expect(send(mine[i % 2] ?? mine[0] as never)).resolves.toBeUndefined(); // 4 + 4 bytes across two pages
    // The notice is sent BEFORE the socket is closed (a closing socket no longer delivers it).
    const order: string[] = [];
    const base = mine[0]?.base.connection as unknown as { sendStateless(p: string): void; webSocket: { close(code: number, reason: string): void } };
    const sendStateless = base.sendStateless.bind(base); const close = base.webSocket.close.bind(base.webSocket);
    base.sendStateless = (p: string) => { order.push('notice'); sendStateless(p); };
    base.webSocket.close = (code: number, reason: string) => { order.push('close'); close(code, reason); };
    await expect(send(mine[0] as never)).rejects.toMatchObject({ code: 4429 }); // 12 > 10
    expect(order).toEqual(['notice', 'close']);
    expect(mine[0]?.base.closes).toContainEqual({ code: 4429, reason: 'rate-limited' });
    await expect(send(theirs)).resolves.toBeUndefined();
    clock.advance(1000);
    await expect(send(mine[1] as never)).resolves.toBeUndefined();
  });
});

describe('admission taken at arrival: when it is given back', () => {
  /** One open arriving: returns its connection config (the identity of the open: Hocuspocus passes the same object to every hook of it). */
  const arrive = (h: Harness, peerId: string, socketId: string, page: number, userId = 'u'): object => {
    const connectionConfig = {};
    h.ext.admit({ context: { peerId }, socketId, documentName: pageName(page), connectionConfig }, userId);
    return connectionConfig;
  };

  it('a socket that closes while its documents are still opening gives their places back', () => {
    const h = harness({ maxDocumentsPerUser: 2 });
    arrive(h, 'p1', 's1', 1); arrive(h, 'p1', 's1', 2);
    expect(documents(h)).toBe(2);
    h.ext.abandonSocket('p1');
    expect(documents(h)).toBe(0);
    expect(() => arrive(h, 'p2', 's2', 3)).not.toThrow();
  });

  it('a hook that fails for an open gives back what THAT open holds, whichever hook it was; an open that was not admitted yet holds nothing', () => {
    const h = harness({ maxDocumentsPerUser: 1 });
    for (const hook of ['onLoadDocument', 'afterLoadDocument', 'connected', 'a later onAuthenticate', 'an extension of the same priority as auth']) {
      const open = arrive(h, 'p', 's', 1);
      expect(documents(h), `${hook} (before)`).toBe(1);
      h.ext.connectFailed({ open });
      expect(documents(h), `${hook} (after)`).toBe(0);
    }
    h.ext.connectFailed({ open: {} }); // an open that was never admitted: nothing to give back
    h.ext.connectFailed({ open: undefined });
    expect(documents(h)).toBe(0);
  });

  it('a failure of ANOTHER open of the same document on the same socket gives nothing back: a place is released only by the open that holds it', () => {
    const h = harness({ maxDocumentsPerUser: 2 });
    const first = arrive(h, 'p', 's', 1); // the first open of the document is still loading
    h.ext.connectFailed({ open: {} }); // a second open of the same document (another session) refused before it was admitted, say by an extension that runs before auth
    expect(documents(h), 'the first open keeps its place').toBe(1);
    h.ext.connectFailed({ open: first });
    expect(documents(h)).toBe(0);
  });

  it('two opens of one document on one socket for different users keep their own places', () => {
    const h = harness({ maxDocumentsPerUser: 1 });
    const mine = arrive(h, 'p', 's', 1, 'u'); const yours = arrive(h, 'p', 's', 1, 'v');
    h.ext.connectFailed({ open: yours });
    expect(() => arrive(h, 'p', 's2', 2, 'v')).not.toThrow(); // v's place came back
    expect(() => arrive(h, 'p', 's3', 3, 'u')).toThrow(); // u's place is still held by its own open
    h.ext.connectFailed({ open: mine });
  });

  it('destroying the host gives every place back, and a release that comes later does nothing', async () => {
    const h = harness({ maxDocumentsPerUser: 2 });
    const s = session(h, 'u', 's1', 1);
    await s.connect();
    arrive(h, 'p', 's9', 2);
    await h.ext.onDestroy?.({} as never);
    expect(documents(h)).toBe(0);
    s.close(); // the connection's own release arrives after the reset
    expect(documents(h)).toBe(0);
  });

  it('page, socket and server counts of an admission that is given back are returned too', () => {
    const h = harness({ maxConnections: 1, maxConnectionsPerPage: 1 });
    arrive(h, 'p', 's1', 1);
    expect(() => arrive(h, 'q', 's2', 1, 'v')).toThrow(); // the page has its one socket
    h.ext.abandonSocket('p');
    expect(() => arrive(h, 'q', 's2', 1, 'v')).not.toThrow();
  });
});
