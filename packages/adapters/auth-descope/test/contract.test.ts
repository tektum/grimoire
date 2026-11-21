import DescopeClient from '@descope/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySdkError } from '../src/index.js';
import { goodClaims, makeKey, nowSec, PID, sign } from './helpers.js';

/**
 * CONTRACT TESTS: they drive the REAL Descope SDK (no mock of it) through every case the adapter tells apart by the SHAPE of the SDK's error,
 * with an injected `fetch`, and assert the exact shape `classifySdkError` depends on. After any @descope/* version change these tests, not production, show a difference.
 */
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function failureOf(fetchImpl: typeof fetch, token: string): Promise<Error> {
  const sdk = DescopeClient({ projectId: PID, baseUrl: 'http://127.0.0.1:9', fetch: fetchImpl });
  try {
    await sdk.validateJwt(token);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error('validateJwt unexpectedly accepted the token');
}

const NO_KEY = 'failed to fetch matching key';

describe('SDK error contract (real SDK, injected fetch)', () => {
  it('key endpoint unreachable: plain Error "failed to fetch matching key", no code', async () => {
    const k = await makeKey('K1');
    const e = await failureOf((() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch, await sign(k.pair, 'K1'));
    expect(e.message).toBe(NO_KEY);
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(classifySdkError(e)).toBe('no-key');
  });

  it('a 200 with an unusable key set: the same plain error', async () => {
    const k = await makeKey('K1');
    for (const body of [{ keys: [] }, {}, { keys: 'x' }]) {
      const e = await failureOf((() => Promise.resolve(json(body))) as typeof fetch, await sign(k.pair, 'K1'));
      expect(e.message).toBe(NO_KEY);
      expect((e as { code?: unknown }).code).toBeUndefined();
      expect(classifySdkError(e)).toBe('no-key');
    }
  });

  it('an unknown key id against a healthy endpoint: the same plain error', async () => {
    const k = await makeKey('K1');
    const e = await failureOf((() => Promise.resolve(json({ keys: [k.jwk] }))) as typeof fetch, await sign(k.pair, 'GHOST'));
    expect(e.message).toBe(NO_KEY);
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(classifySdkError(e)).toBe('no-key');
  });

  it('an expired token: a jose error with code ERR_JWT_EXPIRED', async () => {
    const k = await makeKey('K1');
    const t = nowSec();
    const e = await failureOf((() => Promise.resolve(json({ keys: [k.jwk] }))) as typeof fetch, await sign(k.pair, 'K1', goodClaims({ iat: t - 7200, exp: t - 3600 })));
    expect((e as { code?: unknown }).code).toBe('ERR_JWT_EXPIRED');
    expect(classifySdkError(e)).toBe('token');
  });

  it('a bad signature: a jose error with code ERR_JWS_SIGNATURE_VERIFICATION_FAILED', async () => {
    const k = await makeKey('K1');
    const other = await makeKey('K1');
    const e = await failureOf((() => Promise.resolve(json({ keys: [k.jwk] }))) as typeof fetch, await sign(other.pair, 'K1'));
    expect((e as { code?: unknown }).code).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    expect(classifySdkError(e)).toBe('token');
  });

  it('a token without a key id: Error "header.kid must not be empty", no code', async () => {
    const k = await makeKey('K1');
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const e = await failureOf((() => Promise.resolve(json({ keys: [k.jwk] }))) as typeof fetch, `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(goodClaims())}.AAAA`);
    expect(e.message).toBe('header.kid must not be empty');
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(classifySdkError(e)).toBe('token');
  });
});

describe('classifySdkError defaults', () => {
  it('refuses to recognise anything else', () => {
    expect(classifySdkError(new Error('something new'))).toBe('unrecognised');
    expect(classifySdkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('unrecognised');
    expect(classifySdkError('failed to fetch matching key')).toBe('unrecognised');
    expect(classifySdkError(undefined)).toBe('unrecognised');
  });
});

describe('known property: a newly published key is picked up within the SDK\'s 30 s cooldown (real SDK, fake clock, no waiting)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a token signed by a new key id is refused within 30 s of the last key fetch and accepted after it; a removed key stays refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const k1 = await makeKey('K1');
    const k2 = await makeKey('K2');
    let served = [k1.jwk];
    let fetches = 0;
    const fetchImpl = (() => { fetches += 1; return Promise.resolve(json({ keys: served })); }) as typeof fetch;
    const sdk = DescopeClient({ projectId: PID, baseUrl: 'http://127.0.0.1:9', fetch: fetchImpl });
    const claims = (): Record<string, unknown> => goodClaims({ iat: nowSec(), exp: nowSec() + 600 });
    const old = await sign(k1.pair, 'K1', claims());
    await sdk.validateJwt(old);
    expect(fetches).toBe(1);

    // The provider rotates: the key set now holds only K2.
    served = [k2.jwk];
    const fresh = await sign(k2.pair, 'K2', claims());
    vi.setSystemTime(Date.now() + 10_000);
    await expect(sdk.validateJwt(fresh)).rejects.toThrow(NO_KEY); // within the cooldown: no refetch, the new key is not known yet
    expect(fetches).toBe(1);

    vi.setSystemTime(Date.now() + 21_000); // 31 s after the last fetch
    await expect(sdk.validateJwt(fresh)).resolves.toBeDefined();
    expect(fetches).toBe(2);
    await expect(sdk.validateJwt(old)).rejects.toThrow(NO_KEY); // the removed key is gone from the refetched set
  });
});
