import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { isDescopeProjectId } from '@tektum/grimoire-core/ports/auth-verifier';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, KeyServer, makeKey, PID, sign, type KeyPair } from './helpers.js';

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
  closers.splice(0).forEach((c) => c());
  await server.stop();
});

const make = (o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock: { now: () => Date.now() }, fetchTimeoutMs: 300, ...o });
  closers.push(() => v.close());
  return { v, lines: cap.lines };
};
const kind = async (v: ReturnType<typeof make>['v'], kid: string): Promise<string> => (await v.verify(await sign(pair, kid))).kind;

describe('a fetched key set counts only if it holds a key we can use (RS256, RSA, signing use, a sound modulus)', () => {
  const unusable: Array<[string, (j: typeof jwk) => typeof jwk]> = [
    ['wrong key type', (j) => ({ ...j, kty: 'EC' })],
    ['wrong algorithm', (j) => ({ ...j, alg: 'RS512' })],
    ['encryption use', (j) => ({ ...j, use: 'enc' })],
    ['malformed modulus', (j) => ({ ...j, n: 'AA' })],
    ['missing exponent', (j) => Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'e')) as typeof jwk],
  ];
  it.each(unusable)('cold cache, only an unusable key (%s): service-unavailable, never invalid-token', async (_n, bad) => {
    server.keys = [bad(jwk)];
    const { v, lines } = make();
    expect(await kind(v, 'SK1')).toBe('service-unavailable');
    expect(lines.some((l) => l.event === 'auth.keys_reload_failed')).toBe(true);
  });
  it('an empty set is refused the same way', async () => {
    server.keys = [];
    expect(await kind(make().v, 'SK1')).toBe('service-unavailable');
  });
  it('a set with one unusable and one usable key is accepted', async () => {
    server.keys = [{ ...jwk, kid: 'EC1', kty: 'EC' }, jwk];
    expect(await kind(make().v, 'SK1')).toBe('ok');
  });
  it.each(unusable)('warm cache: a later set with only an unusable key (%s) leaves the old keys in place', async (_n, bad) => {
    const { v } = make({ cooldownMs: 1 });
    expect(await kind(v, 'SK1')).toBe('ok');
    server.keys = [bad(jwk)];
    await new Promise((r) => setTimeout(r, 10));
    expect(await kind(v, 'GHOST')).toBe('service-unavailable'); // the refetch it triggers fails
    expect(await kind(v, 'SK1')).toBe('ok'); // the old keys are still used
  });
  it('a valid set that lacks the token key id is a normal rotation case: invalid-token, refetched at most once per cooldown', async () => {
    const { v } = make({ cooldownMs: 60_000 });
    expect(await kind(v, 'GHOST')).toBe('invalid-token');
    expect(await kind(v, 'GHOST2')).toBe('invalid-token');
    expect(server.requests).toBe(1);
  });
});

describe('one shared refresh', () => {
  const stale = async (behaviour: 'ok' | { status: number }) => {
    const clock = new FakeClock(Date.now());
    const { v } = make({ clock, staleMaxAgeMs: 1000, failureBackoffMs: 50 });
    expect(await kind(v, 'SK1')).toBe('ok');
    expect(server.requests).toBe(1);
    clock.advance(2000);
    server.behaviour = behaviour;
    return v;
  };
  it('twenty concurrent verifications with a stale cache cause exactly one fetch (successful refresh)', async () => {
    const v = await stale('ok');
    const token = await sign(pair, 'SK1');
    const results = await Promise.all(Array.from({ length: 20 }, () => v.verify(token)));
    expect(server.requests).toBe(2);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
  });
  it('twenty concurrent verifications with a stale cache and a failing refresh cause exactly one fetch, all service-unavailable, no unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const on = (e: unknown): number => rejections.push(e);
    process.on('unhandledRejection', on);
    try {
      const v = await stale({ status: 500 });
      const token = await sign(pair, 'SK1');
      const results = await Promise.all(Array.from({ length: 20 }, () => v.verify(token)));
      await new Promise((r) => setTimeout(r, 20));
      expect(server.requests).toBe(2);
      expect(new Set(results.map((r) => r.kind))).toEqual(new Set(['service-unavailable']));
      expect(rejections).toEqual([]);
    } finally { process.off('unhandledRejection', on); }
  });
});

describe('the project id rule is one predicate', () => {
  it('the configuration loader and the verifier use the same exported predicate', () => {
    for (const bad of ['P1-foo', 'a b', '', 'x'.repeat(129), 'é']) {
      expect(isDescopeProjectId(bad), bad).toBe(false);
      expect(() => createDescopeVerifier({ projectId: bad, logger: captureLogger().logger, clock: { now: () => 0 } }), bad).toThrow();
    }
    expect(isDescopeProjectId(PID)).toBe(true);
  });
});
