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
  const connect = () => h.ext.connected?.({ documentName: name, socketId, context: { userId }, connection } as never) ?? Promise.resolve();
  return { base, connect, close: () => { for (const f of closers.splice(0)) f(); } };
}

describe('per-user caps on the limits extension', () => {
  it('refuses with the full-for-you reason and the BUSY close code, a fixed reason on the socket, and frees on close', async () => {
    const h = harness({ maxSocketsPerUser: 2, maxDocumentsPerUser: 3 });
    const live = [session(h, 'u', 's1', 1), session(h, 'u', 's1', 2), session(h, 'u', 's1', 3)];
    for (const s of live) await s.connect();
    const fourth = session(h, 'u', 's2', 4);
    await expect(fourth.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(fourth.base.closes).toEqual([{ code: 4503, reason: 'full-for-you' }]);
    expect(h.limitHits().at(-1)).toEqual({ limit: 'user-documents', value: 3, max: 3 });
    await session(h, 'other', 's9', 4).connect(); // a second user still connects
    live[0]?.close();
    await expect(session(h, 'u', 's2', 4).connect()).resolves.toBeUndefined();
  });

  it('a connection that is already gone takes no place in the server or page counts', async () => {
    const h = harness({ maxConnections: 1, maxConnectionsPerPage: 1 });
    await session(h, 'u', 'sg', 1, { gone: true }).connect();
    await expect(session(h, 'v', 's2', 1).connect()).resolves.toBeUndefined(); // the one place is still free
  });

  it('a socket whose only document is refused closes whole; with admitted siblings only the refused document closes', async () => {
    const h = harness({ maxDocumentsPerUser: 2 });
    const a = session(h, 'u', 's1', 1); const b = session(h, 'u', 's1', 2);
    await a.connect(); await b.connect();
    const third = session(h, 'u', 's1', 3);
    await expect(third.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(third.base.socketCloses).toEqual([]); // siblings on this socket: only the refused document closes
    expect(third.base.closes).toEqual([{ code: 4503, reason: 'full-for-you' }]);
    const lone = session(h, 'u', 's2', 4);
    await expect(lone.connect()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(lone.base.socketCloses).toEqual([{ code: 4503, reason: 'full-for-you' }]); // nothing else on it: the whole socket goes
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
