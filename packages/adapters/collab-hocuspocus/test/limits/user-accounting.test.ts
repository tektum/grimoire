import { describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { createUserAccounting } from '../../src/user-accounting.js';
import type { Admission } from '../../src/user-accounting.js';

/** Seeded generator: fast-check is not installed, and a fixed seed keeps a failure reproducible. */
const rng = (seed: number) => { let s = seed >>> 0; return (n: number): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.floor((s / 2 ** 32) * n); }; };
const caps = { sockets: 3, documents: 5, bytesPerWindow: 1000, windowMs: 1000 };
const fresh = () => { const clock = new FakeClock(0); return { clock, acc: createUserAccounting(caps, clock) }; };

describe('per-user accounting', () => {
  it('counts extra sessions on one socket and on one document as separate sessions, and release frees exactly one', () => {
    const { acc } = fresh();
    const a = acc.admit('u', 's1'); const b = acc.admit('u', 's1');
    expect(acc.counts()).toMatchObject({ sockets: 1, documents: 2 });
    if (a.ok) { a.release(); a.release(); } // idempotent
    expect(acc.counts()).toMatchObject({ sockets: 1, documents: 1 });
    if (b.ok) b.release();
    expect(acc.counts()).toEqual({ users: 0, sockets: 0, documents: 0, windows: 0 });
  });

  it('refuses past the socket cap and the document cap, and one user at the cap never affects another', () => {
    const { acc } = fresh();
    for (const s of ['a', 'b', 'c']) expect(acc.admit('u', s).ok).toBe(true);
    expect(acc.admit('u', 'd')).toMatchObject({ ok: false, limit: 'sockets', value: 3, max: 3 });
    expect(acc.admit('u', 'a').ok).toBe(true); // an extra session on a socket it already has
    expect(acc.admit('u', 'a').ok).toBe(true);
    expect(acc.admit('u', 'a')).toMatchObject({ ok: false, limit: 'documents', max: 5 });
    expect(acc.admit('v', 'a').ok).toBe(true); // the same socket id under another user is another user's socket
    expect(acc.counts()).toMatchObject({ users: 2, sockets: 4, documents: 6 });
  });

  it('a refused admission changes nothing', () => {
    const { acc } = fresh();
    for (const s of ['a', 'b', 'c']) acc.admit('u', s);
    const before = acc.counts();
    acc.admit('u', 'd');
    expect(acc.counts()).toEqual(before);
  });

  it('property: over random interleavings for several users every count matches the model, none exceeds a cap, and all return to zero', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const { clock, acc } = fresh();
      const users = ['u0', 'u1', 'u2', 'u3'];
      const live: { user: string; socket: string; release: () => void }[] = [];
      for (let step = 0; step < 400; step++) {
        const op = r(10);
        if (op < 5) {
          const user = users[r(users.length)] ?? 'u0'; const socket = `${user}-s${String(r(5))}`;
          const res: Admission = acc.admit(user, socket);
          if (res.ok) live.push({ user, socket, release: res.release });
        } else if (op < 8 && live.length > 0) {
          const [gone] = live.splice(r(live.length), 1); gone?.release(); gone?.release();
        } else if (op === 8 && live.length > 0) { // a whole socket goes away (disconnect, timeout, shutdown of one socket)
          const victim = live[r(live.length)];
          for (const l of live.filter((x) => x.socket === victim?.socket)) l.release();
          for (let i = live.length - 1; i >= 0; i--) if (live[i]?.socket === victim?.socket) live.splice(i, 1);
        } else {
          clock.advance(r(1500));
          for (const u of users) acc.charge(u, r(400));
        }
        for (const u of users) {
          const mine = live.filter((l) => l.user === u);
          expect(mine.length).toBeLessThanOrEqual(caps.documents);
          expect(new Set(mine.map((l) => l.socket)).size).toBeLessThanOrEqual(caps.sockets);
        }
        const total = acc.counts();
        expect(total.documents).toBe(live.length);
        expect(total.sockets).toBe(new Set(live.map((l) => `${l.user}\0${l.socket}`)).size);
      }
      for (const l of live) l.release();
      clock.advance(5000);
      const probe = acc.admit('probe', 'x'); // sweeping happens on use
      expect(probe.ok).toBe(true);
      expect(acc.counts()).toMatchObject({ sockets: 1, documents: 1, windows: 0 });
    }
  });
});

describe('per-user byte budget', () => {
  it('charges across pages, refuses past the budget without charging, resets on the Clock, and is per user', () => {
    const { clock, acc } = fresh();
    acc.admit('u', 's'); acc.admit('v', 't');
    expect(acc.charge('u', 600)).toBe(true);
    expect(acc.charge('u', 400)).toBe(true); // exactly the budget
    expect(acc.charge('u', 1)).toBe(false);
    expect(acc.charge('v', 1000)).toBe(true); // another user is unaffected
    clock.advance(1000);
    expect(acc.charge('u', 1000)).toBe(true);
    expect(acc.charge('u', 1001)).toBe(false); // larger than a whole budget is never accepted
  });

  it('reconnecting inside the window does not renew the budget, and expired windows leave no entry behind', () => {
    const { clock, acc } = fresh();
    const first = acc.admit('u', 's');
    acc.charge('u', 1000);
    if (first.ok) first.release();
    expect(acc.counts().windows).toBe(1);
    acc.admit('u', 's2');
    expect(acc.charge('u', 1)).toBe(false);
    const last = acc.admit('u', 's3');
    expect(last.ok).toBe(true);
    clock.advance(2000);
    const other = acc.admit('w', 'x');
    if (other.ok) other.release();
    expect(acc.counts().windows).toBe(0);
  });

  it('reset drops everything and a late release is a no-op', () => {
    const { acc } = fresh();
    const a = acc.admit('u', 's');
    acc.reset();
    if (a.ok) a.release();
    expect(acc.counts()).toEqual({ users: 0, sockets: 0, documents: 0, windows: 0 });
  });
});
