import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_CLOSES } from '../../src/refusal.js';
import { maxFailedRounds } from '../../src/extensions/recheck.js';
import { INTERVAL_MS, PAGE, rig, subjectVerifier, SUBJECT, U1 } from './support.js';
import type { Rig } from './support.js';

const NOT_FOUND = { code: 4205, reason: 'access-changed' }; // every denial at re-check: the admitted user already knew the page; existence is hidden at connect
const stops: Rig[] = [];
const started = (r: Rig): Rig => { stops.push(r); return r; };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const r of stops.splice(0)) r.recheck.stop(); vi.useRealTimers(); });

describe('access changes close the document connection within one interval', () => {
  it('a suspended user is closed 4205 access-changed, and collab.access_closed is logged with ids only', async () => {
    const r = started(rig());
    const c = await r.open();
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([]);
    r.t.users.suspend(SUBJECT);
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([NOT_FOUND]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'no-access' }]);
  });

  it.each([
    ['access removed from the collection', (r: Rig) => { r.t.world.collections.forEach((x) => { x.defaultPermission = null; }); }],
    ['the page is trashed', (r: Rig) => { r.t.world.pages.forEach((p) => { p.deleted = true; }); }],
    ['the page row is gone', (r: Rig) => { r.t.world.pages.splice(0); }],
    ['the collection is trashed', (r: Rig) => { r.t.world.collections.forEach((x) => { x.deleted = true; }); }],
  ])('%s: closed 4205 access-changed', async (_name, change) => {
    const r = started(rig());
    const c = await r.open();
    change(r);
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([NOT_FOUND]);
  });

  it('a user whose row is gone is closed', async () => {
    const r = started(rig());
    const c = await r.open({ userId: '0a000000-0000-4000-8000-0000000000ff' });
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([NOT_FOUND]);
  });

  it('a bumped state_epoch closes with 4205 access-changed', async () => {
    const r = started(rig());
    const c = await r.open();
    r.t.world.pages.forEach((p) => { p.epoch = 1; });
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([{ code: SESSION_CLOSES['access-changed'], reason: 'access-changed' }]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'epoch' }]);
  });

  it('write lowered to read: closed 4205 access-changed once, so the reconnect is authorised afresh as read-only', async () => {
    const r = started(rig());
    const c = await r.open();
    await r.t.users.updateRole(U1, 'viewer');
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([{ code: 4205, reason: 'access-changed' }]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'access-changed' }]);
    await r.elapse(INTERVAL_MS * 3);
    expect(c.closes).toHaveLength(1);
  });

  it('read raised to write: closed with 4205 so that the reconnect is authorised again (the contract: a new right is a close)', async () => {
    const r = started(rig({ role: 'viewer' }));
    const c = await r.open({ level: 'read-only' });
    await r.t.users.updateRole(U1, 'member');
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([{ code: 4205, reason: 'access-changed' }]);
  });

  it('only the changed user\'s documents close: two users, one page', async () => {
    const r = started(rig());
    const a = await r.open({ peerId: 'p1' });
    const b = await r.open({ peerId: 'p2', userId: (await r.t.idOf('u2')) ?? '', subject: 'u2' });
    r.t.users.suspend(SUBJECT);
    await r.elapse(INTERVAL_MS);
    expect(a.closes).toEqual([NOT_FOUND]);
    expect(b.closes).toEqual([]);
  });
});

describe('session expiry', () => {
  it('a session past expiresAt is closed 4401 session-expired within one interval, also when the round\'s query fails; a valid one is not closed and recheck_skipped is logged once', async () => {
    const r = started(rig());
    const short = await r.open({ expiresInMs: 3000 });
    const long = await r.open({ peerId: 'p2', expiresInMs: 3_600_000 });
    r.store.fail = new Error('database down');
    await r.elapse(INTERVAL_MS); // t = 2 s: not yet expired
    expect(short.closes).toEqual([]);
    await r.elapse(INTERVAL_MS); // t = 4 s: expired at 3 s, closed by this round although the query rejected
    expect(short.closes).toEqual([{ code: 4401, reason: 'session-expired' }]);
    expect(long.closes).toEqual([]);
    expect(r.events('collab.recheck_skipped')).toEqual([{ reason: 'database' }]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'session-expired' }]);
  });

  it('expiry exactly at the round is expired (<=)', async () => {
    const r = started(rig());
    const c = await r.open({ expiresInMs: INTERVAL_MS });
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([{ code: 4401, reason: 'session-expired' }]);
  });
});

describe('cost', () => {
  it('50 open connections: one facts call per round; no connection: three intervals make no call and no timer remains', async () => {
    const r = started(rig());
    expect(vi.getTimerCount()).toBe(0);
    await r.elapse(INTERVAL_MS * 3);
    expect(r.store.calls).toBe(0);
    const pages = Array.from({ length: 50 }, (_, i) => `1c7e0f3a-5b2d-4e8f-8a11-${String(i).padStart(12, '0')}`);
    for (const p of pages) r.t.world.pages.push({ id: p, collectionId: r.t.world.collections[0]?.id ?? '', deleted: false, epoch: 0 });
    for (const p of pages) await r.open({ page: p });
    await r.elapse(INTERVAL_MS);
    expect(r.store.calls).toBe(1);
    await r.elapse(INTERVAL_MS);
    expect(r.store.calls).toBe(2);
    for (const c of r.connections) c.close();
    expect(vi.getTimerCount()).toBe(0);
    await r.elapse(INTERVAL_MS * 3);
    expect(r.store.calls).toBe(2);
  });

  it('the same user on the same page in several tabs is one request; 2,500 distinct documents are three bounded batches', async () => {
    const r = started(rig());
    const sizes: number[] = [];
    const facts = r.store.facts.bind(r.store);
    r.store.facts = (rs) => { sizes.push(rs.length); return facts(rs); };
    await r.open({ peerId: 'a' }); await r.open({ peerId: 'b' }); await r.open({ peerId: 'c' });
    await r.recheck.round();
    expect(sizes).toEqual([1]);
    sizes.length = 0;
    const collection = r.t.world.collections[0]?.id ?? '';
    for (let i = 0; i < 2500; i++) {
      const id = `2c7e0f3a-5b2d-4e8f-8a11-${String(i).padStart(12, '0')}`;
      r.t.world.pages.push({ id, collectionId: collection, deleted: false, epoch: 0 });
      await r.open({ page: id });
    }
    await r.recheck.round();
    expect(sizes).toEqual([1000, 1000, 501]);
  });

  it('1,000 open documents: one query, every decision applied, and the event loop is not held for long', async () => {
    vi.useRealTimers();
    const r = started(rig());
    const collection = r.t.world.collections[0]?.id ?? '';
    for (let i = 0; i < 1000; i++) {
      const id = `3c7e0f3a-5b2d-4e8f-8a11-${String(i).padStart(12, '0')}`;
      r.t.world.pages.push({ id, collectionId: collection, deleted: i % 2 === 0, epoch: 0 });
      await r.open({ page: id });
    }
    let longest = 0;
    let last = performance.now();
    let running = true;
    const watcher = (async () => { while (running) { await yieldToLoop(); const now = performance.now(); longest = Math.max(longest, now - last); last = now; } })();

    await r.recheck.round();

    running = false; await watcher;
    expect(r.store.calls).toBe(1);
    expect(r.connections.filter((c) => c.closes.length === 1)).toHaveLength(500);
    expect(longest).toBeLessThan(200);
  });

  it('rounds do not overlap: while one is waiting for the database the following ticks do nothing', async () => {
    const r = started(rig());
    await r.open();
    const facts = r.store.facts.bind(r.store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    r.store.facts = async (rs) => { await gate; return facts(rs); };
    await r.elapse(INTERVAL_MS * 4);
    expect(r.store.calls).toBe(0); // the replaced facts never reached the counter
    r.store.facts = facts;
    release();
    await r.elapse(INTERVAL_MS);
    expect(r.store.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('the database is down: fail closed, but not fragile', () => {
  it('two failed rounds close nobody and log one throttled line; when the database returns, checks resume', async () => {
    const r = started(rig());
    const c = await r.open();
    r.store.fail = new Error('database down');
    await r.elapse(INTERVAL_MS * 2);
    expect(c.closes).toEqual([]);
    expect(r.events('collab.recheck_skipped')).toEqual([{ reason: 'database' }]);
    r.store.fail = undefined;
    r.t.users.suspend(SUBJECT);
    await r.elapse(INTERVAL_MS);
    expect(c.closes).toEqual([NOT_FOUND]);
  });

  it(`after ${String(maxFailedRounds(60))} failed rounds in a row (never fewer than 3, never less than 120 s) the connections close with the try-again code`, async () => {
    const r = started(rig({ intervalSeconds: 60 }));
    const c = await r.open();
    r.store.fail = new Error('database down');
    await r.elapse(60_000 * 2);
    expect(c.closes).toEqual([]);
    await r.elapse(60_000);
    expect(c.closes).toEqual([{ code: 4503, reason: 'try-again' }]);
    expect(r.events('collab.access_closed')).toEqual([{ pageId: PAGE, reason: 'recheck-unavailable' }]);
    expect(maxFailedRounds(1)).toBe(120);
    expect(maxFailedRounds(60)).toBe(3);
  });

  it('a success in between resets the count (a blip every other round never closes anyone)', async () => {
    const r = started(rig({ intervalSeconds: 60 }));
    const c = await r.open();
    for (let i = 0; i < 6; i++) { r.store.fail = i % 2 === 0 ? new Error('blip') : undefined; await r.elapse(60_000); }
    expect(c.closes).toEqual([]);
  });

  it('a database that hangs is a failed round, not a stuck one', async () => {
    const r = started(rig());
    const c = await r.open();
    r.store.facts = () => new Promise(() => undefined);
    await r.elapse(INTERVAL_MS * 10);
    expect(c.closes).toEqual([]);
    expect(r.events('collab.recheck_skipped').length).toBeGreaterThanOrEqual(1);
  });

  it('a database whose query HANGS (never errors) still reaches the failed-round limit: the session is closed try-again, not kept for ever', async () => {
    const r = started(rig({ intervalSeconds: 60 }));
    const c = await r.open();
    r.store.facts = () => new Promise(() => undefined);
    await r.elapse(60_000 * (maxFailedRounds(60) + 2));
    expect(c.closes).toEqual([{ code: 4503, reason: 'try-again' }]);
  });

  it('a query that hangs past its 5 s limit is never stacked: while it is unanswered no second query starts', async () => {
    const r = started(rig({ intervalSeconds: 1 }));
    await r.open();
    const facts = vi.fn(() => new Promise<never>(() => undefined));
    r.store.facts = facts as never;
    await r.elapse(30_000);
    expect(facts).toHaveBeenCalledTimes(1);
  });
});

describe('the token round', () => {
  it('a connection whose session ends within two intervals is asked for a token; a fresh one extends it and nothing closes', async () => {
    const r = started(rig());
    subjectVerifier(r);
    const c = await r.open({ expiresInMs: 5000 });
    await r.elapse(INTERVAL_MS);
    expect(c.requestToken).toHaveBeenCalledTimes(1);
    const fresh = r.t.clock.now() + 3_600_000;
    await r.tokenSync(c, `sub:${SUBJECT}:${String(fresh)}`);
    expect(c.context['expiresAt']).toBe(fresh);
    await r.elapse(INTERVAL_MS * 5);
    expect(c.closes).toEqual([]);
    expect(c.requestToken).toHaveBeenCalledTimes(1);
  });

  it('a connection with a distant expiry is not asked', async () => {
    const r = started(rig());
    const c = await r.open({ expiresInMs: 3_600_000 });
    await r.elapse(INTERVAL_MS * 3);
    expect(c.requestToken).not.toHaveBeenCalled();
  });

  it('the handshake form g1.<base64url json> is read: only t is verified', async () => {
    const r = started(rig());
    subjectVerifier(r);
    const c = await r.open({ expiresInMs: 5000 });
    const fresh = r.t.clock.now() + 3_600_000;
    const t = Buffer.from(JSON.stringify({ t: `sub:${SUBJECT}:${String(fresh)}`, v: 1, e: 7 })).toString('base64url');
    await r.tokenSync(c, `g1.${t}`);
    expect(c.context['expiresAt']).toBe(fresh);
  });

  it('a client that never answers is closed at expiry', async () => {
    const r = started(rig());
    const c = await r.open({ expiresInMs: 5000 });
    await r.elapse(INTERVAL_MS * 4);
    expect(c.closes).toEqual([{ code: 4401, reason: 'session-expired' }]);
  });

  it('a token for ANOTHER USER is refused: the connection is closed, its identity, level and expiry are untouched, and no row of the other user is used', async () => {
    const r = started(rig());
    subjectVerifier(r);
    const c = await r.open({ expiresInMs: 5000 });
    const before = { ...c.context };
    await r.tokenSync(c, `sub:u2:${String(r.t.clock.now() + 3_600_000)}`);
    expect(c.closes).toEqual([{ code: 4401, reason: 'invalid-token' }]);
    expect(c.context).toEqual(before);
    expect(r.events('collab.token_sync_failed')).toEqual([{ pageId: PAGE, reason: 'user-mismatch' }]);
    expect(r.t.resolve.calls).toBe(0);
  });

  it('an invalid token (malformed, expired, refresh, other project, bad signature) closes the connection 4401 invalid-token; the identity is untouched', async () => {
    for (const bad of ['garbage', `sub:${SUBJECT}:1`]) { // the second: the verifier says ok, the host's own expiry rule says no
      const r = started(rig());
      subjectVerifier(r);
      const c = await r.open({ expiresInMs: 7000 });
      const before = { ...c.context };
      await r.tokenSync(c, bad);
      expect(c.closes).toEqual([{ code: 4401, reason: 'invalid-token' }]);
      expect(c.context).toEqual(before);
      expect(r.events('collab.token_sync_failed')).toEqual([{ pageId: PAGE, reason: 'invalid' }]);
    }
  });

  it('a token that fails verification AFTER the connection\'s own expiry closes it session-expired, not invalid-token (R4.14): the session expired, the sweep has not run yet', async () => {
    for (const stale of [`sub:${SUBJECT}:1`, 'garbage']) { // the same subject\'s expired token (what the provider answers at the boundary) and an unverifiable one
      const r = started(rig());
      subjectVerifier(r);
      const c = await r.open({ expiresInMs: 5000 });
      r.t.clock.advance(5500); // past expiry, before the next sweep tick
      await r.tokenSync(c, stale);
      expect(c.closes).toEqual([{ code: 4401, reason: 'session-expired' }]);
    }
  });

  it('(boundary guard) a token that fails verification just BEFORE the connection\'s expiry is still invalid-token, and another person\'s valid token after expiry is still invalid-token', async () => {
    const r = started(rig());
    subjectVerifier(r);
    const early = await r.open({ expiresInMs: 5000 });
    r.t.clock.advance(4999); // one millisecond before expiry
    await r.tokenSync(early, 'garbage');
    expect(early.closes).toEqual([{ code: 4401, reason: 'invalid-token' }]);
    const late = await r.open({ expiresInMs: 5000 });
    r.t.clock.advance(5500);
    await r.tokenSync(late, `sub:u2:${String(r.t.clock.now() + 3_600_000)}`); // valid, but another user: the identity check is not a staleness matter
    expect(late.closes).toEqual([{ code: 4401, reason: 'invalid-token' }]);
  });

  it('a verifier outage is not an invalid token: the connection is kept to its own expiry, collab.auth_unavailable is logged, and a later token is accepted', async () => {
    const r = started(rig());
    r.t.verifier.result = { kind: 'service-unavailable' };
    const c = await r.open({ expiresInMs: 5000 });
    await r.tokenSync(c, 'whatever');
    expect(c.closes).toEqual([]);
    expect(r.events('collab.auth_unavailable')).toEqual([{ source: 'verifier' }]);
    expect(r.events('collab.token_sync_failed')).toEqual([]);
    subjectVerifier(r);
    const fresh = r.t.clock.now() + 3_600_000;
    await r.tokenSync(c, `sub:${SUBJECT}:${String(fresh)}`);
    expect(c.context['expiresAt']).toBe(fresh);
    expect(c.closes).toEqual([]);
  });

  it('a verifier that throws during a token round is an outage too: kept, collab.auth_unavailable', async () => {
    const r = started(rig());
    r.t.verifier.verify = () => Promise.reject(new Error('key server unreachable'));
    const c = await r.open({ expiresInMs: 5000 });
    await r.tokenSync(c, 'whatever');
    expect(c.closes).toEqual([]);
    expect(r.events('collab.auth_unavailable')).toEqual([{ source: 'verifier' }]);
  });

  it('token presentations are rate-limited per connection: five verifications per minute, the rest are ignored', async () => {
    const r = started(rig());
    r.t.verifier.result = { kind: 'service-unavailable' }; // refused presentations that keep the connection, so the window is what is measured
    const c = await r.open({ expiresInMs: 5000 });
    for (let i = 0; i < 9; i++) await r.tokenSync(c, 'garbage');
    expect(r.t.verifier.calls).toBe(5);
    expect(c.closes).toEqual([]);
    expect(r.events('collab.token_sync_failed').map((e) => e['reason'])).toEqual(['rate-limited']);
    r.t.clock.advance(61_000);
    await r.tokenSync(c, 'garbage');
    expect(r.t.verifier.calls).toBe(6);
  });

  it('no token reaches a log line or the connection', async () => {
    const r = started(rig());
    subjectVerifier(r);
    const c = await r.open({ expiresInMs: 5000 });
    const d = await r.open({ peerId: 'p2', expiresInMs: 5000 });
    const e = await r.open({ peerId: 'p3', expiresInMs: 5000 });
    await r.tokenSync(c, 'sub:u2:99999999999-SECRET');
    await r.tokenSync(d, 'SECRET-garbage');
    await r.tokenSync(e, `sub:${SUBJECT}:${String(r.t.clock.now() + 3_600_000)}`);
    const dump = JSON.stringify([r.t.logger.entries, c.context, d.context, e.context, c.closes, d.closes]);
    expect(dump).not.toContain('SECRET');
    expect(dump).not.toContain('sub:');
  });
});

describe('lifecycle', () => {
  it('after stop() no round runs and a late connection starts no timer; the timer does not keep the process alive', async () => {
    const r = started(rig());
    const c = await r.open();
    r.recheck.stop();
    expect(vi.getTimerCount()).toBe(0);
    r.t.users.suspend(SUBJECT);
    await r.elapse(INTERVAL_MS * 3);
    expect(c.closes).toEqual([]);
    await r.open({ peerId: 'late' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the interval timer is unref\'d (real timers: it is not an active handle)', async () => {
    vi.useRealTimers();
    const r = started(rig({ intervalSeconds: 600 }));
    const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    await r.open();
    expect(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length).toBe(before);
    r.recheck.stop();
  });

  it('the interval is config.collab.recheckSeconds', async () => {
    const r = started(rig({ intervalSeconds: 7 }));
    const c = await r.open();
    r.t.users.suspend(SUBJECT);
    await r.elapse(6_999);
    expect(c.closes).toEqual([]);
    await r.elapse(1);
    expect(c.closes).toEqual([NOT_FOUND]);
  });
});
