import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, goodClaims, KeyServer, makeKey, nowSec, PID, sign, type Behaviour, type KeyPair, SyncedClock, syncDate } from './helpers.js';

syncDate();

const server = new KeyServer();
let pair: KeyPair;
let jwk: Awaited<ReturnType<typeof makeKey>>['jwk'];
const closers: Array<() => void> = [];
const realClock = { now: (): number => Date.now() };

beforeEach(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  jwk = k.jwk;
  server.requests = 0;
  server.paths = [];
  server.behaviour = 'ok';
  server.keys = [jwk];
  await server.start();
});
afterEach(async () => {
  vi.useRealTimers();
  closers.splice(0).forEach((c) => c());
  await server.stop();
});

const make = (o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock: realClock, fetchTimeoutMs: 300, ...o });
  closers.push(() => v.close());
  return { v, lines: cap.lines };
};

describe('key cache', () => {
  it('2,000 verifications of one token cause exactly one key fetch', async () => {
    const { v } = make();
    const t = await sign(pair, 'SK1');
    for (let i = 0; i < 2000; i += 1) expect((await v.verify(t)).kind).toBe('ok');
    expect(server.requests).toBe(1);
  });

  it('an unknown kid on a cold cache costs one fetch, then cached refusal inside the cooldown', async () => {
    const { v } = make();
    for (let i = 0; i < 20; i += 1) expect(await v.verify(await sign(pair, 'GHOST'))).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(1);
  });

  it('1,000 bad tokens with random kids cause a bounded number of key-server requests (<= 2)', async () => {
    const { v } = make();
    const tokens = await Promise.all(Array.from({ length: 1000 }, () => sign(pair, randomBytes(8).toString('hex'))));
    const results = await Promise.all(tokens.map((t) => v.verify(t)));
    expect(results.every((r) => r.kind === 'invalid-token')).toBe(true);
    expect(server.requests).toBeLessThanOrEqual(2);
  });

  it('1,000 bad tokens against a failing key server cause at most 2 requests and all say service-unavailable', async () => {
    server.behaviour = { status: 500 };
    const { v } = make();
    const t = await sign(pair, 'SK1');
    const results: string[] = [];
    for (let i = 0; i < 1000; i += 1) results.push((await v.verify(t)).kind);
    expect(new Set(results)).toEqual(new Set(['service-unavailable']));
    expect(server.requests).toBeLessThanOrEqual(2);
  });

  it('a failing server is retried after the failure backoff, and recovery is seen', async () => {
    const clock = new SyncedClock(Date.now());
    server.behaviour = { status: 500 };
    const { v } = make({ clock, failureBackoffMs: 5000 });
    const t = await sign(pair, 'SK1');
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    server.behaviour = 'ok';
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    expect(server.requests).toBe(1);
    clock.advance(5001);
    expect((await v.verify(t)).kind).toBe('ok');
    expect(server.requests).toBe(2);
  });
});

describe('rotation and cooldown (the SDK cooldown runs on Date, faked here)', () => {
  it('a rotated kid inside the SDK 30 s cooldown is invalid-token, ok after the cooldown (one refetch)', async () => {
    const { v } = make();
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    const k2 = await makeKey('SK2');
    server.keys = [jwk, k2.jwk];
    const t2 = await sign(k2.pair, 'SK2');
    vi.setSystemTime(Date.now() + 10_000);
    expect(await v.verify(t2)).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(1);
    vi.setSystemTime(Date.now() + 25_000);
    const fresh = await sign(k2.pair, 'SK2');
    expect((await v.verify(fresh)).kind).toBe('ok');
    expect(server.requests).toBe(2);
    expect((await v.verify(fresh)).kind).toBe('ok');
    expect(server.requests).toBe(2);
  });

  it('an unknown kid after the cooldown causes one refetch, then cached refusal again', async () => {
    const { v } = make();
    await v.verify(await sign(pair, 'SK1'));
    vi.setSystemTime(Date.now() + 31_000);
    for (let i = 0; i < 5; i += 1) expect(await v.verify(await sign(pair, 'GHOST'))).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(2);
  });
});

describe('key refresh and the one-hour limit (the SDK refreshes on demand: after 10 minutes, and keeps no key older than one hour)', () => {
  const MIN = 60_000;
  const long = (): Promise<string> => sign(pair, 'SK1', goodClaims({ exp: nowSec() + 24 * 3600 }));
  it('a failing refresh keeps a warm cache usable for up to one hour, then service-unavailable (and it is logged)', async () => {
    const clock = new SyncedClock(Date.now());
    const { v, lines } = make({ clock });
    expect((await v.verify(await long())).kind).toBe('ok');
    expect(server.requests).toBe(1);
    await server.stop();
    clock.advance(11 * MIN);
    expect((await v.verify(await long())).kind).toBe('ok'); // the refresh failed, the old keys still serve
    expect(lines.filter((l) => l.event === 'auth.keys_reload_failed').length).toBe(1);
    expect(lines.some((l) => l.event === 'auth.keys_unavailable')).toBe(false);
    clock.advance(40 * MIN);
    expect((await v.verify(await long())).kind).toBe('ok'); // 51 minutes since the last good fetch
    clock.advance(10 * MIN);
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' }); // 61 minutes
    expect(lines.find((l) => l.event === 'auth.keys_unavailable')?.level).toBe('error');
  });

  it('a refresh after the 10-minute TTL picks up a rotated key', async () => {
    const clock = new SyncedClock(Date.now());
    const { v } = make({ clock });
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    const k2 = await makeKey('SK2');
    server.keys = [jwk, k2.jwk];
    clock.advance(11 * MIN);
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    expect(server.requests).toBe(2);
    expect((await v.verify(await sign(k2.pair, 'SK2'))).kind).toBe('ok');
    expect(server.requests).toBe(2);
  });

  it('after the one-hour limit a recovered key server restores service on the next verification', async () => {
    const clock = new SyncedClock(Date.now());
    const { v } = make({ clock });
    await v.verify(await long());
    server.behaviour = { status: 500 };
    clock.advance(61 * MIN);
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
    server.behaviour = 'ok';
    clock.advance(31_000); // past the SDK's 30 s attempt cooldown and our failure backoff
    expect((await v.verify(await long())).kind).toBe('ok');
  });

  const KEYS_CAP = 256 * 1024;
  const overCap = (): string => JSON.stringify({ keys: [jwk], pad: 'x'.repeat(KEYS_CAP + 1) });
  it.each([
    ['over the cap by declared length', (): Behaviour => ({ raw: overCap() })],
    ['over the cap, streamed without a declared length', (): Behaviour => ({ chunked: overCap() })],
    ['an empty object', (): Behaviour => ({ raw: '{}' })],
    ['not JSON', (): Behaviour => ({ raw: 'this is not json' })],
  ])('past the one-hour limit, a key server answering 200 with %s does not refresh the last-good time', async (_name, behaviour) => {
    const clock = new SyncedClock(Date.now());
    const { v } = make({ clock });
    expect((await v.verify(await long())).kind).toBe('ok');
    server.behaviour = behaviour();
    clock.advance(61 * MIN);
    const before = server.requests;
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
    expect(server.requests).toBeGreaterThan(before); // the 200 answer was actually fetched and refused
    clock.advance(31_000); // past the failure backoff: a second refusal must not have freshened the clock either
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
  });

  it('close() leaves no background work: there is no timer, nothing fetches after it', async () => {
    const clock = new SyncedClock(Date.now());
    const { v } = make({ clock });
    await v.verify(await sign(pair, 'SK1'));
    v.close();
    clock.advance(30 * MIN);
    expect(server.requests).toBe(1);
  });
});

describe('logs carry nothing secret', () => {
  it('no token, kid, key material or claim value appears in any log line', async () => {
    const { v, lines } = make();
    const good = await sign(pair, 'SK1');
    const bad = await sign(pair, 'SECRETKID');
    await v.verify(good);
    await v.verify(bad);
    server.behaviour = { status: 500 };
    const s2 = make({ baseUrl: server.url });
    await s2.v.verify(good);
    const text = JSON.stringify([...lines, ...s2.lines]);
    for (const secret of [good, bad, 'SECRETKID', 'U2user', String(jwk.n), good.split('.')[1] ?? 'x']) expect(text).not.toContain(secret);
  });
});

describe('key health follows the latest key fetch (F1)', () => {
  const unknown = async (n: string) => sign(pair, `GHOST-${n}`);
  const SETTLE = 6000; // past the failure backoff
  const COOLDOWN = 31_000; // past the SDK's 30 s unknown-kid cooldown

  it('failed fetch, then a good one: an unknown kid is invalid-token, not service-unavailable', async () => {
    const clock = new SyncedClock(Date.now());
    server.behaviour = { status: 500 };
    const { v } = make({ clock });
    expect(await v.verify(await unknown('a'))).toEqual({ kind: 'service-unavailable' });
    server.behaviour = 'ok';
    clock.advance(SETTLE);
    expect(await v.verify(await unknown('b'))).toEqual({ kind: 'invalid-token' });
    clock.advance(COOLDOWN);
    expect(await v.verify(await unknown('c'))).toEqual({ kind: 'invalid-token' });
  });

  it('healthy, then a failed fetch: an unknown kid is service-unavailable', async () => {
    const clock = new SyncedClock(Date.now());
    const { v } = make({ clock });
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    clock.advance(COOLDOWN);
    server.behaviour = { status: 500 };
    expect(await v.verify(await unknown('a'))).toEqual({ kind: 'service-unavailable' });
  });

  it('flapping (fail, succeed, fail, succeed): the reason follows each fetch', async () => {
    const clock = new SyncedClock(Date.now());
    server.behaviour = { status: 500 };
    const { v } = make({ clock });
    expect(await v.verify(await unknown('1'))).toEqual({ kind: 'service-unavailable' });
    server.behaviour = 'ok';
    clock.advance(SETTLE);
    expect(await v.verify(await unknown('2'))).toEqual({ kind: 'invalid-token' });
    server.behaviour = { status: 500 };
    clock.advance(COOLDOWN);
    expect(await v.verify(await unknown('3'))).toEqual({ kind: 'service-unavailable' });
    server.behaviour = 'ok';
    clock.advance(SETTLE + COOLDOWN);
    expect(await v.verify(await unknown('4'))).toEqual({ kind: 'invalid-token' });
  });
});
