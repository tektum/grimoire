import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { createDescopeVerifier } from '../src/index.js';
import { b64, captureLogger, goodClaims, KeyServer, makeKey, nowSec, PID, sign, signHs256WithPublicKeyText, type KeyPair } from './helpers.js';

const server = new KeyServer();
let pair: KeyPair;
let other: KeyPair;
const clock = { now: (): number => Date.now() };
const make = (extra: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock, fetchTimeoutMs: 3000, ...extra });
  return { v, lines: cap.lines };
};
const closers: Array<() => void> = [];
const verifier = (extra: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => { const r = make(extra); closers.push(() => r.v.close()); return r; };

beforeAll(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  other = (await makeKey('SK1')).pair;
  server.keys = [k.jwk];
  await server.start();
});
afterAll(async () => { closers.forEach((c) => c()); await server.stop(); });

describe('verify: valid token', () => {
  it('a valid token gives ok with userId = sub and expiresAt = exp * 1000', async () => {
    const t = nowSec();
    const r = await verifier().v.verify(await sign(pair, 'SK1', goodClaims({ iat: t, exp: t + 600 })));
    expect(r).toEqual({ kind: 'ok', userId: 'U2user', expiresAt: (t + 600) * 1000, tenant: { kind: 'none' } });
  });
  it('a token carrying aud is accepted when no audience is configured', async () => {
    expect((await verifier().v.verify(await sign(pair, 'SK1', goodClaims({ aud: 'anything' })))).kind).toBe('ok');
  });
  it('an issuer in the configured issuers list is accepted', async () => {
    const iss = `https://api.descope.com/${PID}`;
    expect((await verifier({ issuers: [PID, iss] }).v.verify(await sign(pair, 'SK1', goodClaims({ iss })))).kind).toBe('ok');
  });
});

describe('verify: single-claim defects are invalid-token', () => {
  const t = nowSec();
  const omit = (k: string): Record<string, unknown> => { const c = goodClaims(); delete c[k]; return c; };
  it.each([
    ['missing sub', omit('sub')],
    ['empty sub', goodClaims({ sub: '' })],
    ['numeric sub', goodClaims({ sub: 42 })],
    ['object sub', goodClaims({ sub: { a: 1 } })],
    ['missing exp', omit('exp')],
    ['string exp', goodClaims({ exp: String(t + 600) })],
    ['missing iat', omit('iat')],
    ['string iat', goodClaims({ iat: String(t) })],
    ['missing iss', omit('iss')],
    ['expired', goodClaims({ iat: t - 700, exp: t - 100 })],
    ['not yet valid (nbf)', goodClaims({ nbf: t + 3600 })],
    ['far-future iat', goodClaims({ iat: t + 86_400, exp: t + 87_000 })],
    ['iss wrong project', goodClaims({ iss: 'P2otherprojectidabcdefghijk' })],
    ['iss url form not configured', goodClaims({ iss: `https://api.descope.com/${PID}` })],
    ['iss trailing slash', goodClaims({ iss: `${PID}/` })],
    ['iss uppercase', goodClaims({ iss: PID.toUpperCase() })],
    ['iss prefix only', goodClaims({ iss: PID.slice(0, 10) })],
    ['iss array', goodClaims({ iss: [PID] })],
    ['iss empty', goodClaims({ iss: '' })],
  ])('%s', async (_n, claims) => {
    expect(await verifier().v.verify(await sign(pair, 'SK1', claims))).toEqual({ kind: 'invalid-token' });
  });
  it('wrong audience, missing audience, right audience when configured', async () => {
    const v = verifier({ audience: 'grimoire' }).v;
    expect(await v.verify(await sign(pair, 'SK1', goodClaims({ aud: 'other' })))).toEqual({ kind: 'invalid-token' });
    expect(await v.verify(await sign(pair, 'SK1', goodClaims()))).toEqual({ kind: 'invalid-token' });
    expect((await v.verify(await sign(pair, 'SK1', goodClaims({ aud: 'grimoire' })))).kind).toBe('ok');
  });
});

describe('verify: token type, lifetime bound and sub rules', () => {
  const t = nowSec();
  const kinds = async (claims: Record<string, unknown>, extra: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) =>
    (await verifier(extra).v.verify(await sign(pair, 'SK1', claims))).kind;
  it.each([
    ['refresh value DSR', { drn: 'DSR' }],
    ['other value', { drn: 'XX' }],
    ['lowercase ds', { drn: 'ds' }],
    ['numeric', { drn: 1 }],
    ['array', { drn: ['DS'] }],
  ])('drn %s is invalid', async (_n, c) => { expect(await kinds(goodClaims(c))).toBe('invalid-token'); });
  it('a token without drn is invalid', async () => {
    const c = goodClaims(); delete c['drn'];
    expect(await kinds(c)).toBe('invalid-token');
  });
  it('exp far in the future (year 3000, 1e300) is invalid', async () => {
    expect(await kinds(goodClaims({ exp: 32_503_680_000 }))).toBe('invalid-token');
    expect(await kinds(goodClaims({ exp: 1e300 }))).toBe('invalid-token');
  });
  it('the issued lifetime (exp - iat) is bounded too, not only what remains', async () => {
    expect(await kinds(goodClaims({ iat: t - 7200, exp: t + 600 }), { maxTokenLifetimeMs: 3_600_000 })).toBe('invalid-token');
    expect(await kinds(goodClaims({ iat: t - 600, exp: t + 600 }), { maxTokenLifetimeMs: 3_600_000 })).toBe('ok');
    expect(await kinds(goodClaims({ iat: t - 3000, exp: t + 600 }), { maxTokenLifetimeMs: 3_600_000 })).toBe('ok');
  });
  it('remaining lifetime above the default 24 h is invalid, just inside it is ok, and the maximum is configurable', async () => {
    expect(await kinds(goodClaims({ exp: t + 24 * 3600 + 60 }))).toBe('invalid-token');
    expect(await kinds(goodClaims({ exp: t + 24 * 3600 - 60 }))).toBe('ok');
    expect(await kinds(goodClaims({ exp: t + 7200 }), { maxTokenLifetimeMs: 3_600_000 })).toBe('invalid-token');
    expect(await kinds(goodClaims({ exp: t + 600 }), { maxTokenLifetimeMs: 3_600_000 })).toBe('ok');
  });
  it.each([
    ['fractional exp', { exp: t + 600.5 }],
    ['fractional iat', { iat: t - 0.5 }],
    ['fractional nbf', { nbf: t - 10.5 }],
    ['negative iat', { iat: -5 }],
    ['string nbf', { nbf: String(t - 10) }],
  ])('%s is invalid', async (_n, c) => { expect(await kinds(goodClaims(c))).toBe('invalid-token'); });
  it.each([
    ['NUL', 'U2\u0000x'],
    ['leading space', ' U2x'],
    ['trailing space', 'U2x '],
    ['trailing newline', 'U2x\n'],
    ['inner tab', 'U2\tx'],
    ['DEL', 'U2\u007fx'],
    ['C1 control', 'U2\u0085x'],
    ['unicode edge space', '\u00a0U2x'],
    ['too long', 'U'.repeat(257)],
  ])('sub with %s is invalid', async (_n, sub) => { expect(await kinds(goodClaims({ sub }))).toBe('invalid-token'); });
  it('a sub of 1 to 256 printable characters without edge whitespace is accepted', async () => {
    expect(await kinds(goodClaims({ sub: 'U' }))).toBe('ok');
    expect(await kinds(goodClaims({ sub: 'U2abc-def_ghi:ü' }))).toBe('ok');
    expect(await kinds(goodClaims({ sub: 'U'.repeat(256) }))).toBe('ok');
  });
});

describe('verify: signature and algorithm attacks are invalid-token', () => {
  it('signed by another key under the same kid', async () => {
    expect(await verifier().v.verify(await sign(other, 'SK1'))).toEqual({ kind: 'invalid-token' });
  });
  it('unknown kid', async () => {
    expect(await verifier().v.verify(await sign(pair, 'NOPE'))).toEqual({ kind: 'invalid-token' });
  });
  it('alg none', async () => {
    const t = `${b64({ alg: 'none', kid: 'SK1' })}.${b64(goodClaims())}.`;
    expect(await verifier().v.verify(t)).toEqual({ kind: 'invalid-token' });
  });
  it('HS256 token signed with the public key text', async () => {
    expect(await verifier().v.verify(await signHs256WithPublicKeyText(pair, 'SK1'))).toEqual({ kind: 'invalid-token' });
  });
  it('a different asymmetric algorithm (PS256) signed by the right key', async () => {
    const ps = await generateKeyPair('PS256', { extractable: true });
    server.keys = [...server.keys, { ...(await exportJWK(ps.publicKey)), kid: 'PS1', alg: 'PS256', use: 'sig' }];
    try {
      expect((await verifier().v.verify(await sign(ps, 'PS1', goodClaims(), 'PS256'))).kind).toBe('invalid-token');
    } finally { server.keys = server.keys.filter((k) => k.kid !== 'PS1'); }
  });
  it('a jku header is never followed', async () => {
    const decoy = new KeyServer();
    await decoy.start();
    try {
      const [h, p, s] = (await sign(pair, 'SK1')).split('.');
      const tampered = `${b64({ alg: 'RS256', kid: 'SK1', jku: `${decoy.url}/jwks` })}.${p}.${s}`;
      expect(h).toBeDefined();
      expect((await verifier().v.verify(tampered)).kind).toBe('invalid-token');
      expect(decoy.requests).toBe(0);
    } finally { await decoy.stop(); }
  });
  it.each(['', 'abc', 'a.b.c', '....', 'a.b', '\u0000.\u0000.\u0000', `${b64({ alg: 'RS256' })}.${b64('[]')}.AAAA`])('malformed %j', async (t) => {
    const before = server.requests;
    expect(await verifier().v.verify(t)).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(before); // bytes that are not a token cost no network request (M3-T02 146)
  });
  it('a non-string token', async () => {
    expect(await verifier().v.verify(undefined as unknown as string)).toEqual({ kind: 'invalid-token' });
  });
});

describe('verify: token length and size (security review N2)', () => {
  it('a 1 MiB string and a 9 KiB string are invalid before any parse or network call', async () => {
    const before = server.requests;
    const spy = vi.spyOn(globalThis, 'fetch');
    const { v } = verifier();
    const start = performance.now();
    expect(await v.verify('a'.repeat(1024 * 1024))).toEqual({ kind: 'invalid-token' });
    expect(await v.verify('a'.repeat(9 * 1024))).toEqual({ kind: 'invalid-token' });
    expect(performance.now() - start).toBeLessThan(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(server.requests).toBe(before);
  });
  it('a 4 KiB valid token is accepted', async () => {
    const token = await sign(pair, 'SK1', goodClaims({ pad: 'p'.repeat(2700) }));
    expect(token.length).toBeGreaterThan(4000);
    expect(token.length).toBeLessThan(4600);
    expect((await verifier().v.verify(token)).kind).toBe('ok');
  });
  it('huge or deeply nested claims in an oversize token are refused quickly with no network call', async () => {
    const before = server.requests;
    const nested = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    const t = `${b64({ alg: 'RS256', kid: 'SK1' })}.${b64(`{"a":${nested}}`)}.AAAA`;
    const start = performance.now();
    expect(await verifier().v.verify(t)).toEqual({ kind: 'invalid-token' });
    expect(performance.now() - start).toBeLessThan(200);
    expect(server.requests).toBe(before);
  });
  it('deeply nested claims inside the size limit with a forged signature are refused quickly', async () => {
    const t = `${b64({ alg: 'RS256', kid: 'SK1' })}.${b64(`{"a":${'['.repeat(3000)}${']'.repeat(3000)}}`)}.AAAA`;
    expect(t.length).toBeLessThanOrEqual(8192);
    const start = performance.now();
    expect(await verifier().v.verify(t)).toEqual({ kind: 'invalid-token' });
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('verify: key server failures are service-unavailable, never ok, never invalid', () => {
  const token = (): Promise<string> => sign(pair, 'SK1');
  it('key server stopped before the first verification (cold cache)', async () => {
    const dead = new KeyServer();
    await dead.start();
    const url = dead.url;
    await dead.stop();
    const cap = captureLogger();
    const v = createDescopeVerifier({ projectId: PID, baseUrl: url, logger: cap.logger, clock, fetchTimeoutMs: 3000 });
    closers.push(() => v.close());
    expect(await v.verify(await token())).toEqual({ kind: 'service-unavailable' });
  });
  it('key server stopped after a successful verification (warm cache) still gives ok', async () => {
    const s = new KeyServer();
    s.keys = server.keys;
    await s.start();
    const v = createDescopeVerifier({ projectId: PID, baseUrl: s.url, logger: captureLogger().logger, clock, fetchTimeoutMs: 3000 });
    closers.push(() => v.close());
    expect((await v.verify(await token())).kind).toBe('ok');
    await s.stop();
    expect((await v.verify(await token())).kind).toBe('ok');
  });
  it.each<[string, 'hang' | { status: number } | { raw: string } | 'huge']>([
    ['HTTP 500', { status: 500 }],
    ['HTTP 404', { status: 404 }],
    ['redirect', { status: 302 }],
    ['invalid JSON', { raw: '{not json' }],
    ['garbage key set', { raw: '{"keys":"x"}' }],
    ['empty key set', { raw: '{"keys":[]}' }],
    ['JSON but no keys', { raw: '[]' }],
    ['timeout', 'hang'],
    ['huge body', 'huge'],
  ])('cold cache, %s', async (_n, behaviour) => {
    const s = new KeyServer();
    s.keys = server.keys;
    s.behaviour = behaviour;
    await s.start();
    try {
      const cap = captureLogger();
      const v = createDescopeVerifier({ projectId: PID, baseUrl: s.url, logger: cap.logger, clock, fetchTimeoutMs: 3000 });
      closers.push(() => v.close());
      expect(await v.verify(await token())).toEqual({ kind: 'service-unavailable' });
      expect(cap.lines.some((l) => l.event === 'auth.keys_reload_failed')).toBe(true);
    } finally { await s.stop(); }
  });
  it('the key URL is built only from project id and base URL', async () => {
    const s = new KeyServer();
    s.keys = server.keys;
    await s.start();
    try {
      const v = createDescopeVerifier({ projectId: PID, baseUrl: `${s.url}/`, logger: captureLogger().logger, clock });
      closers.push(() => v.close());
      await v.verify(await token());
      expect(s.paths).toEqual([`/v2/keys/${PID}`]);
    } finally { await s.stop(); }
  });
});

describe('construction', () => {
  it('throws on an empty project id and on unsafe ids and base URLs', () => {
    const o = { logger: captureLogger().logger, clock };
    expect(() => createDescopeVerifier({ projectId: '', ...o })).toThrow();
    expect(() => createDescopeVerifier({ projectId: 'a/b', ...o })).toThrow();
    expect(() => createDescopeVerifier({ projectId: 'P2.evil.com#', ...o })).toThrow();
    expect(() => createDescopeVerifier({ projectId: PID, baseUrl: 'http://example.com', ...o })).toThrow();
    expect(() => createDescopeVerifier({ projectId: PID, baseUrl: 'ftp://127.0.0.1', ...o })).toThrow();
    expect(() => createDescopeVerifier({ projectId: PID, baseUrl: 'nonsense', ...o })).toThrow();
  });
});
