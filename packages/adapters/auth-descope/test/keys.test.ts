import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, goodClaims, KeyServer, makeKey, nowSec, PID, sign, type Behaviour, type KeyPair } from './helpers.js';

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
    const clock = new FakeClock(Date.now());
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

describe('rotation and cooldown (jose cooldown runs on Date, faked here)', () => {
  it('a rotated kid inside cooldownMs is invalid-token, ok after the cooldown (one refetch)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { v } = make({ cooldownMs: 30_000 });
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
    vi.useFakeTimers({ toFake: ['Date'] });
    const { v } = make({ cooldownMs: 30_000 });
    await v.verify(await sign(pair, 'SK1'));
    vi.setSystemTime(Date.now() + 31_000);
    for (let i = 0; i < 5; i += 1) expect(await v.verify(await sign(pair, 'GHOST'))).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(2);
  });
});

describe('timed reload and stale limit', () => {
  it('a failing reload keeps a warm cache usable until staleMaxAgeMs, then service-unavailable and auth.keys_stale', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = new FakeClock(Date.now());
    const { v, lines } = make({ clock, reloadIntervalMs: 600_000, staleMaxAgeMs: 3_600_000 });
    const long = (): Promise<string> => sign(pair, 'SK1', goodClaims({ exp: nowSec() + 24 * 3600 }));
    expect((await v.verify(await long())).kind).toBe('ok');
    expect(server.requests).toBe(1);
    await server.stop();
    const failures = (): number => lines.filter((l) => l.event === 'auth.keys_reload_failed').length;
    for (let i = 0; i < 6; i += 1) {
      clock.advance(600_000);
      await vi.advanceTimersByTimeAsync(600_000);
      await vi.waitFor(() => expect(failures()).toBe(i + 1));
    }
    expect((await v.verify(await long())).kind).toBe('ok');
    expect(lines.some((l) => l.event === 'auth.keys_stale')).toBe(false);
    clock.advance(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.waitFor(() => expect(lines.filter((l) => l.event === 'auth.keys_reload_failed').length).toBe(7));
    const r = await v.verify(await long());
    expect(r).toEqual({ kind: 'service-unavailable' });
    const stale = lines.find((l) => l.event === 'auth.keys_stale');
    expect(stale?.level).toBe('error');
    expect(stale?.fields).toEqual({ ageSeconds: 4200 });
  });

  it('a successful timed reload refreshes the keys and the stale clock, and picks up a rotated key', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = new FakeClock(Date.now());
    const { v } = make({ clock, reloadIntervalMs: 600_000 });
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    const k2 = await makeKey('SK2');
    server.keys = [jwk, k2.jwk];
    clock.advance(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.waitFor(() => expect(server.requests).toBe(2));
    await vi.waitFor(async () => expect((await v.verify(await sign(k2.pair, 'SK2'))).kind).toBe('ok'));
    expect(server.requests).toBe(2);
  });

  it('after the stale limit a recovered key server restores service on the next verification', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = new FakeClock(Date.now());
    const { v } = make({ clock, staleMaxAgeMs: 1000, reloadIntervalMs: 600_000 });
    const long = (): Promise<string> => sign(pair, 'SK1', goodClaims({ exp: nowSec() + 24 * 3600 }));
    await v.verify(await long());
    server.behaviour = { status: 500 };
    clock.advance(10_000);
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
    server.behaviour = 'ok';
    clock.advance(10_000);
    expect((await v.verify(await long())).kind).toBe('ok');
  });

  const KEYS_CAP = 256 * 1024;
  const overCap = (): string => JSON.stringify({ keys: [jwk], pad: 'x'.repeat(KEYS_CAP + 1) });
  it.each([
    ['over the cap by declared length', (): Behaviour => ({ raw: overCap() })],
    ['over the cap, streamed without a declared length', (): Behaviour => ({ chunked: overCap() })],
    ['an empty object', (): Behaviour => ({ raw: '{}' })],
    ['not JSON', (): Behaviour => ({ raw: 'this is not json' })],
  ])('past the stale limit, a key server answering 200 with %s does not refresh the last-good time', async (_name, behaviour) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = new FakeClock(Date.now());
    const { v } = make({ clock, staleMaxAgeMs: 1000, reloadIntervalMs: 600_000 });
    const long = (): Promise<string> => sign(pair, 'SK1', goodClaims({ exp: nowSec() + 24 * 3600 }));
    expect((await v.verify(await long())).kind).toBe('ok');
    server.behaviour = behaviour();
    clock.advance(10_000);
    const before = server.requests;
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
    expect(server.requests).toBeGreaterThan(before); // the 200 answer was actually fetched and refused
    clock.advance(10_000); // past the failure backoff: a second refusal must not have freshened the clock either
    expect(await v.verify(await long())).toEqual({ kind: 'service-unavailable' });
  });

  it('close() stops the timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { v } = make({ reloadIntervalMs: 1000 });
    await v.verify(await sign(pair, 'SK1'));
    v.close();
    await vi.advanceTimersByTimeAsync(10_000);
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
