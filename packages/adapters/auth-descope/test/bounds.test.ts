import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, goodClaims, KeyServer, makeKey, PID, sign, type KeyPair, SyncedClock, syncDate } from './helpers.js';

syncDate();

// Time is injected (FakeClock); no test here waits.
const T0 = 1_700_000_000;
const KEYS_CAP = 256 * 1024;
const server = new KeyServer();
let pair: KeyPair;
let jwk: Awaited<ReturnType<typeof makeKey>>['jwk'];
const closers: Array<() => void> = [];

beforeEach(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  jwk = k.jwk;
  server.requests = 0;
  server.behaviour = 'ok';
  server.keys = [jwk];
  await server.start();
});
afterEach(async () => {
  vi.useRealTimers();
  closers.splice(0).forEach((c) => c());
  await server.stop();
});

const make = (clock: FakeClock, o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock, fetchTimeoutMs: 3000, ...o });
  closers.push(() => v.close());
  return { v, lines: cap.lines };
};
const claims = (extra: Record<string, unknown>) => goodClaims({ iat: T0, exp: T0 + 600, ...extra });

describe('issued-at time in the future (clock tolerance is 5 s)', () => {
  const kind = async (extra: Record<string, unknown>, o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) =>
    (await make(new SyncedClock(T0 * 1000), o).v.verify(await sign(pair, 'SK1', claims(extra)))).kind;

  it('a token issued 6 seconds ahead of the clock is refused', async () => {
    expect(await kind({ iat: T0 + 6 })).toBe('invalid-token');
  });
  it('a token issued a year ahead of the clock is refused', async () => {
    expect(await kind({ iat: T0 + 365 * 86400, exp: T0 + 365 * 86400 + 600 })).toBe('invalid-token');
  });
  it('a token issued exactly 5 seconds ahead (the tolerance) is accepted', async () => {
    expect(await kind({ iat: T0 + 5 })).toBe('ok');
  });
  it('a token issued now or recently is accepted; issued-at 0 is refused because the issued lifetime would exceed the maximum', async () => {
    expect(await kind({ iat: T0 })).toBe('ok');
    expect(await kind({ iat: T0 - 3600 })).toBe('ok');
    expect(await kind({ iat: 0 })).toBe('invalid-token');
  });
  it('the refusal follows the injected clock, not the real one', async () => {
    const clock = new SyncedClock(T0 * 1000);
    const { v } = make(clock);
    const t = await sign(pair, 'SK1', claims({ iat: T0 + 60, exp: T0 + 660 }));
    expect((await v.verify(t)).kind).toBe('invalid-token');
    clock.advance(55_000);
    expect((await v.verify(t)).kind).toBe('ok');
  });
});

describe('remaining lifetime boundary', () => {
  const kind = async (exp: number) => (await make(new SyncedClock(T0 * 1000), { maxTokenLifetimeMs: 3_600_000 }).v.verify(await sign(pair, 'SK1', claims({ exp })))).kind;
  it('a token living exactly the maximum is accepted and one second more is refused', async () => {
    expect(await kind(T0 + 3600)).toBe('ok');
    expect(await kind(T0 + 3601)).toBe('invalid-token');
  });
});

describe('oversized key-set response', () => {
  /** A valid key set padded to exactly `bytes` bytes. */
  const padded = (bytes: number): string => {
    const base = JSON.stringify({ keys: [jwk], pad: '' });
    return JSON.stringify({ keys: [jwk], pad: 'x'.repeat(bytes - Buffer.byteLength(base)) });
  };
  const verifyOnce = async (clock: FakeClock) => {
    const { v, lines } = make(clock);
    return { result: await v.verify(await sign(pair, 'SK1', claims({}))), lines, v };
  };

  it('a key set whose declared length is over the cap is refused as unavailable and logged as invalid', async () => {
    const body = padded(KEYS_CAP + 1);
    server.behaviour = { raw: body };
    const { result, lines } = await verifyOnce(new SyncedClock(T0 * 1000));
    expect(result).toEqual({ kind: 'service-unavailable' });
    expect(lines.filter((l) => l.event === 'auth.keys_reload_failed').map((l) => l.fields)).toEqual([{ reason: 'invalid' }]);
  });
  it('a declared length over the cap is refused from the headers alone, without waiting for the body', async () => {
    server.behaviour = { stalledAfterHeaders: KEYS_CAP + 1 };
    // a long fetch timeout: a reader that waited for the body would report 'timeout', not 'invalid'
    const { v, lines } = make(new SyncedClock(T0 * 1000), { fetchTimeoutMs: 3000 });
    expect(await v.verify(await sign(pair, 'SK1', claims({})))).toEqual({ kind: 'service-unavailable' });
    expect(lines.filter((l) => l.event === 'auth.keys_reload_failed').map((l) => l.fields)).toEqual([{ reason: 'invalid' }]);
  });
  it('a key set streamed without a declared length and over the cap is refused as unavailable', async () => {
    server.behaviour = { chunked: padded(KEYS_CAP + 1) };
    const { result, lines } = await verifyOnce(new SyncedClock(T0 * 1000));
    expect(result).toEqual({ kind: 'service-unavailable' });
    expect(lines.filter((l) => l.event === 'auth.keys_reload_failed').map((l) => l.fields)).toEqual([{ reason: 'invalid' }]);
  });
  it('a key set of exactly the cap is accepted, declared or streamed', async () => {
    server.behaviour = { raw: padded(KEYS_CAP) };
    expect((await verifyOnce(new SyncedClock(T0 * 1000))).result.kind).toBe('ok');
    server.behaviour = { chunked: padded(KEYS_CAP) };
    expect((await verifyOnce(new SyncedClock(T0 * 1000))).result.kind).toBe('ok');
  });
  it('a refused oversized set is not cached: the same token is accepted once the server serves a normal set after the backoff', async () => {
    for (const behaviour of [{ raw: padded(KEYS_CAP + 1) }, { chunked: padded(KEYS_CAP + 1) }]) {
      server.requests = 0;
      server.behaviour = behaviour;
      const clock = new SyncedClock(T0 * 1000);
      const { v } = make(clock);
      const t = await sign(pair, 'SK1', claims({}));
      expect((await v.verify(t)).kind).toBe('service-unavailable');
      server.behaviour = 'ok';
      expect((await v.verify(t)).kind).toBe('service-unavailable'); // still inside the failure backoff: no new request
      expect(server.requests).toBe(1);
      clock.advance(5001);
      expect((await v.verify(t)).kind).toBe('ok');
      expect(server.requests).toBe(2);
    }
  });
  it('an oversized reload leaves a warm cache as it was', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // jose's cooldown runs on Date
    vi.setSystemTime(T0 * 1000);
    const { v } = make({ now: () => Date.now() } as FakeClock);
    const t = await sign(pair, 'SK1', claims({}));
    expect((await v.verify(t)).kind).toBe('ok');
    server.behaviour = { chunked: padded(KEYS_CAP + 1) };
    vi.setSystemTime(T0 * 1000 + 31_000);
    const later = await sign(pair, 'SK1', claims({ iat: T0 + 31, exp: T0 + 631 }));
    const unknownKid = await sign(pair, 'NOPE', claims({ iat: T0 + 31, exp: T0 + 631 }));
    expect((await v.verify(unknownKid)).kind).toBe('service-unavailable'); // jose reloads, the reload is refused
    expect(server.requests).toBe(2);
    expect((await v.verify(later)).kind).toBe('ok');
  });
});
