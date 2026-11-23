import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { DEFAULT_CONVERT_WAIT_MS } from '../../src/save.js';
import { harness, pageName } from './support.js';

// The reservation ledger of the limits extension: an admission is taken at arrival and expires after a TTL if its open never ends in a way the library tells us about.
const base = makeFakeConfig().collab;
const TTL = (c: { seedTimeoutMs: number; reseedTimeoutMs: number; storeTimeoutMs: number }): number => DEFAULT_CONVERT_WAIT_MS + Math.max(c.seedTimeoutMs, c.reseedTimeoutMs) + 2 * c.storeTimeoutMs;

function ledger(collab: Parameters<typeof harness>[0] = {}) {
  let now = 1_000_000;
  const clock = { now: () => now };
  const h = harness(collab, clock);
  const ttl = TTL({ ...base, ...collab });
  const counts = (): { users: number; sockets: number; documents: number } => (h.ext as unknown as { counts(): { users: number; sockets: number; documents: number } }).counts();
  const arrive = (peerId: string, socketId: string, page: number, userId = 'u'): object => {
    const connectionConfig = {};
    h.ext.admit({ context: { peerId }, socketId, documentName: pageName(page), connectionConfig }, userId);
    return connectionConfig;
  };
  return { h, ttl, counts, arrive, advance: (ms: number) => { now += ms; }, expired: () => h.logger.entries.filter((e) => e.event === 'collab.admission_expired').length };
}

describe('the ledger expires reservations of opens the library dropped silently', () => {
  it('two sockets open the same unloaded page and the load fails: only the first open is told, the second is answered by the library alone; its place is back after the TTL with both sockets still open, and before it no cap is exceeded', () => {
    const l = ledger({ maxDocumentsPerUser: 2 });
    const first = l.arrive('p1', 's1', 1);
    l.arrive('p2', 's2', 1); // the library gives this open the first one's loading promise: no hook of ours runs for it
    l.h.ext.connectFailed({ open: first }); // the shared load failed: the guarded hooks ran once, for the first open
    expect(l.counts().documents, 'the second open still holds its place').toBe(1);
    l.arrive('p1', 's1', 2); // a second place of the same user: at the cap now
    expect(() => l.arrive('p1', 's1', 3), 'the cap is not exceeded while the place is held').toThrow();
    l.advance(l.ttl - 1);
    expect(() => l.arrive('p1', 's1', 3), 'still held one millisecond before the TTL').toThrow();
    l.advance(2);
    expect(() => l.arrive('p1', 's1', 3), 'back after the TTL: the ledger dropped it when it was consulted').not.toThrow();
    expect(l.expired(), 'the silently dropped open and the second place of the same user, both taken at the same time').toBe(2);
    expect(l.counts().documents, 'only the one just taken is held').toBe(1);
  });

  it('an expired reservation is dropped by every kind of consultation, and its page, socket and server counts come back too', () => {
    const l = ledger({ maxConnections: 1, maxConnectionsPerPage: 1 });
    l.arrive('p', 's1', 1);
    expect(() => l.arrive('q', 's2', 1, 'v')).toThrow(); // the page's one socket is held
    l.advance(l.ttl + 1);
    l.h.ext.abandonSocket('nobody'); // any consultation sweeps
    expect(l.counts().documents).toBe(0);
    expect(() => l.arrive('q', 's2', 1, 'v')).not.toThrow();
  });

  it('a reservation that is taken, bound and connected never expires', async () => {
    const l = ledger({ maxDocumentsPerUser: 1 });
    const document = l.h.doc(pageName(1));
    (document as unknown as { hasConnection: () => boolean }).hasConnection = () => true;
    const connection = { ...l.h.conn('s', document).connection, onClose: () => undefined };
    await l.h.open({ documentName: pageName(1), socketId: 's', connection, userId: 'u', context: { userId: 'u' } });
    l.advance(l.ttl * 10);
    l.h.ext.abandonSocket('nobody');
    expect(l.counts().documents).toBe(1);
    expect(l.expired()).toBe(0);
  });
});

describe('a session is given back once, by whichever ends it first', () => {
  const live = (l: ReturnType<typeof ledger>, socketId: string, page: number, userId: string, connected: boolean) => {
    const document = l.h.documents.get(pageName(page)) ?? l.h.doc(pageName(page));
    l.h.documents.set(pageName(page), document);
    (document as unknown as { hasConnection: () => boolean }).hasConnection = () => connected;
    const closers: (() => void)[] = [];
    const connection = { ...l.h.conn(socketId, document).connection, onClose: (fn: () => void) => { closers.push(fn); } };
    return { close: () => { for (const f of closers.splice(0)) f(); }, run: (config: object) => l.h.ext.connected?.({ documentName: pageName(page), socketId, context: { userId, peerId: socketId }, connectionConfig: config, connection } as never) ?? Promise.resolve() };
  };

  it('a reservation that expired and whose open later arrives already dropped gives back nothing a live sibling of the same page on the same socket holds', async () => {
    const l = ledger({ maxConnectionsPerPage: 1, maxDocumentsPerUser: 5 });
    const a = l.arrive('p', 's1', 1);
    l.advance(l.ttl - 5);
    const b = l.arrive('p', 's1', 1); // a live sibling of the same page on the same socket
    await live(l, 's1', 1, 'u', true).run(b);
    l.advance(10); // a's reservation expires
    await live(l, 's1', 1, 'u', false).run(a); // its open finally arrives at `connected`, already dropped
    expect(() => l.arrive('q', 's2', 1, 'v'), 'the page cap of one is still held by the live sibling').toThrow();
  });

  it('an expired open that later connects and closes gives back only its own session', async () => {
    const l = ledger({ maxConnectionsPerPage: 1, maxDocumentsPerUser: 5 });
    const a = l.arrive('p', 's1', 1);
    l.advance(l.ttl - 5);
    const b = l.arrive('p', 's1', 1);
    const liveB = live(l, 's1', 1, 'u', true); await liveB.run(b);
    l.advance(10);
    const lateA = live(l, 's1', 1, 'u', true); await lateA.run(a);
    lateA.close();
    expect(() => l.arrive('q', 's2', 1, 'v'), 'B still holds the one place of the page').toThrow();
    liveB.close();
    expect(() => l.arrive('q', 's2', 1, 'v')).not.toThrow();
  });
});

describe('the server and page caps are checked after the sweep', () => {
  it('a leaked last place does not cost a wrongly refused attempt', async () => {
    const l = ledger({ maxConnections: 1 });
    l.arrive('p', 's1', 1);
    l.advance(l.ttl + 1);
    await expect(l.h.tryConnect(pageName(2), 's2')).resolves.toBeUndefined();
  });
});

describe('`connected` without a live reservation is the late check against the same caps', () => {
  const connectLate = (l: ReturnType<typeof ledger>, socketId: string, page: number, userId: string) => {
    const document = l.h.documents.get(pageName(page)) ?? l.h.doc(pageName(page));
    l.h.documents.set(pageName(page), document);
    const c = l.h.conn(socketId, document);
    const closers: (() => void)[] = [];
    const connection = { ...c.connection, onClose: (fn: () => void) => { closers.push(fn); } };
    (document as unknown as { hasConnection: () => boolean }).hasConnection = () => true;
    return { c, close: () => { for (const f of closers.splice(0)) f(); }, run: () => l.h.ext.connected?.({ documentName: pageName(page), socketId, context: { userId, peerId: socketId }, connectionConfig: {}, connection } as never) ?? Promise.resolve() };
  };

  it('within the cap it is admitted and bound to the connection', async () => {
    const l = ledger({ maxDocumentsPerUser: 1 });
    const open = connectLate(l, 's', 1, 'u');
    await open.run();
    expect(l.counts().documents).toBe(1);
    open.close();
    expect(l.counts().documents).toBe(0);
  });

  it('over the cap it is refused with the usual reason and its connection is closed', async () => {
    const l = ledger({ maxDocumentsPerUser: 1 });
    l.arrive('p', 's1', 1);
    const late = connectLate(l, 's2', 2, 'u');
    await expect(late.run()).rejects.toMatchObject({ reason: 'full-for-you' });
    expect(late.c.closes).toEqual([{ code: expect.any(Number) as number, reason: 'full-for-you' }]);
    expect(l.counts().documents).toBe(1);
  });

  it('an open slower than the TTL (its reservation expired) is still admitted when it finally connects, if the caps allow', async () => {
    const l = ledger({ maxDocumentsPerUser: 1 });
    l.arrive('p', 's', 1);
    l.advance(l.ttl + 1);
    l.h.ext.abandonSocket('nobody');
    expect(l.counts().documents).toBe(0);
    await connectLate(l, 's', 1, 'u').run();
    expect(l.counts().documents).toBe(1);
  });
});

// A model of the ledger: random opens, failures, silent drops, connections, closes, socket closes and time passing, checked against what the ledger must hold.
describe('model: no cap is exceeded by more than the opens still in flight, and every counter returns to the truth within the TTL of the last event', () => {
  const rng = (seed: number) => { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; }; };
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i', async (seed) => {
    const random = rng(seed);
    const CAP = 3;
    const l = ledger({ maxDocumentsPerUser: CAP, maxSocketsPerUser: 4 });
    interface Open { config: object; userId: string; page: number; socket: string; state: 'pending' | 'connected' | 'ended'; at: number; close?: () => void }
    const opens: Open[] = [];
    let time = 0;
    const users = ['a', 'b', 'c'];
    const check = (): void => {
      // The truth: connected opens, and pending ones that have not expired (a silently dropped one stays pending until it expires).
      const live = opens.filter((o) => o.state === 'connected' || (o.state === 'pending' && time - o.at < l.ttl));
      for (const u of users) expect(live.filter((o) => o.userId === u).length, `user ${u} never holds more than the cap`).toBeLessThanOrEqual(CAP);
    };
    for (let step = 0; step < 150; step++) {
      const r = random();
      if (r < 0.4) {
        const o: Open = { config: {}, userId: users[Math.floor(random() * 3)]!, page: 1 + Math.floor(random() * 4), socket: `s${String(Math.floor(random() * 4))}`, state: 'pending', at: time };
        try { l.h.ext.admit({ context: { peerId: o.socket }, socketId: o.socket, documentName: pageName(o.page), connectionConfig: o.config }, o.userId); opens.push(o); } catch { /* refused: holds nothing */ }
      } else if (r < 0.55) {
        const o = opens.find((x) => x.state === 'pending');
        if (o) { l.h.ext.connectFailed({ open: o.config }); o.state = 'ended'; } // a failing guarded hook
      } else if (r < 0.65) {
        const o = opens.find((x) => x.state === 'pending');
        if (o) { o.at = o.at; /* dropped silently by the library: nothing is told; it stays pending until it expires */ opens.splice(opens.indexOf(o), 1, { ...o, state: 'pending' }); }
      } else if (r < 0.8) {
        const o = opens.find((x) => x.state === 'pending' && time - x.at < l.ttl);
        if (o) {
          const document = l.h.documents.get(pageName(o.page)) ?? l.h.doc(pageName(o.page));
          l.h.documents.set(pageName(o.page), document);
          (document as unknown as { hasConnection: () => boolean }).hasConnection = () => true;
          const closers: (() => void)[] = [];
          const connection = { ...l.h.conn(o.socket, document).connection, onClose: (fn: () => void) => { closers.push(fn); } };
          await l.h.ext.connected?.({ documentName: pageName(o.page), socketId: o.socket, context: { userId: o.userId, peerId: o.socket }, connectionConfig: o.config, connection } as never);
          o.state = 'connected'; o.close = () => { for (const f of closers.splice(0)) f(); void l.h.disconnect(pageName(o.page), o.socket, 0, document); };
        }
      } else if (r < 0.9) {
        const o = opens.find((x) => x.state === 'connected');
        if (o) { o.close?.(); o.state = 'ended'; }
      } else if (r < 0.95) {
        const peer = `s${String(Math.floor(random() * 4))}`;
        l.h.ext.abandonSocket(peer);
        for (const o of opens) if (o.state === 'pending' && o.socket === peer) o.state = 'ended';
      } else {
        const ms = Math.floor(random() * l.ttl * 0.6);
        l.advance(ms); time += ms;
        l.h.ext.abandonSocket('nobody'); // a consultation: expired reservations are dropped
        for (const o of opens) if (o.state === 'pending' && time - o.at >= l.ttl) o.state = 'ended';
      }
      check();
    }
    // Within the TTL of the last event every counter equals the connected opens.
    l.advance(l.ttl + 1); l.h.ext.abandonSocket('nobody');
    const connected = opens.filter((o) => o.state === 'connected');
    expect(l.counts().documents).toBe(connected.length);
  });
});
