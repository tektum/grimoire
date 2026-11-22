import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { b64, captureLogger, goodClaims, KeyServer, makeKey, PID, sign, type Behaviour, type KeyPair, SyncedClock, syncDate } from './helpers.js';

syncDate();

// Time is injected; the only waits are the sockets of the local servers.
const T0 = 1_700_000_000;
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
  const clock = new SyncedClock(T0 * 1000);
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock, fetchTimeoutMs: 3000, ...o });
  closers.push(() => v.close());
  return { v, lines: cap.lines, clock };
};
const claims = (extra: Record<string, unknown> = {}) => goodClaims({ iat: T0, exp: T0 + 600, ...extra });
const verify = async (extra: Record<string, unknown> = {}, o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) => make(o).v.verify(await sign(pair, 'SK1', claims(extra)));
const reasons = (lines: ReturnType<typeof captureLogger>['lines']) => lines.filter((l) => l.event === 'auth.keys_reload_failed').map((l) => l.fields?.['reason']);

describe('why the key set could not be used is logged, and the caller sees unavailable', () => {
  const cases: Array<[string, Behaviour, string]> = [
    ['an answer other than 200 that carries a valid key set', { status: 203, keys: true }, 'http'],
    ['a redirect', { status: 302 }, 'http'],
    ['JSON null', { raw: 'null' }, 'invalid'],
    ['a JSON string', { raw: '"keys"' }, 'invalid'],
    ['not JSON', { raw: '{nope' }, 'invalid'],
    ['a keys member that is not an array', { raw: '{"keys":{}}' }, 'invalid'],
    ['a hanging server', 'hang', 'timeout'],
  ];
  it.each(cases)('%s', async (_n, behaviour, reason) => {
    server.behaviour = behaviour;
    const { v, lines } = make({ fetchTimeoutMs: behaviour === 'hang' ? 50 : 3000 });
    expect(await v.verify(await sign(pair, 'SK1', claims()))).toEqual({ kind: 'service-unavailable' });
    expect(reasons(lines)).toEqual([reason]);
  });
  it('a server that is not listening is a network failure', async () => {
    const { v, lines } = make({ baseUrl: 'http://127.0.0.1:1' });
    expect(await v.verify(await sign(pair, 'SK1', claims()))).toEqual({ kind: 'service-unavailable' });
    expect(reasons(lines)).toEqual(['network']);
  });
  it('a key set whose keys are not keys is unavailable, not a verdict on the token', async () => {
    server.behaviour = { raw: '{"keys":[1]}' };
    expect(await make().v.verify(await sign(pair, 'SK1', claims()))).toEqual({ kind: 'service-unavailable' });
  });
  it('the failure backoff ends exactly at its deadline', async () => {
    server.behaviour = { status: 500 };
    const { v, clock } = make({ failureBackoffMs: 5000 });
    const t = await sign(pair, 'SK1', claims());
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    server.behaviour = 'ok';
    clock.advance(4999);
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    expect(server.requests).toBe(1);
    clock.advance(1);
    expect((await v.verify(t)).kind).toBe('ok');
    expect(server.requests).toBe(2);
  });
});

describe('keys unavailable', () => {
  it('is logged once per 30 s while the verifier answers unavailable (no key younger than the SDK one-hour limit)', async () => {
    const { v, lines, clock } = make({ failureBackoffMs: 1 });
    const t = await sign(pair, 'SK1', claims({ exp: T0 + 7200 }));
    expect((await v.verify(t)).kind).toBe('ok');
    server.behaviour = { status: 500 };
    clock.advance(3_600_001);
    const logged = () => lines.filter((l) => l.event === 'auth.keys_unavailable').length;
    for (let i = 0; i < 3; i += 1) expect((await v.verify(t)).kind).toBe('service-unavailable');
    expect(logged()).toBe(1);
    clock.advance(29_999); // 1 ms short of the interval since the first log
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    expect(logged()).toBe(1);
    clock.advance(1);
    expect((await v.verify(t)).kind).toBe('service-unavailable');
    expect(logged()).toBe(2);
  });
});

describe('construction options', () => {
  it('an empty issuers list means the project id is the only accepted issuer', async () => {
    expect((await verify({}, { issuers: [] })).kind).toBe('ok');
    expect((await verify({ iss: 'someone-else' }, { issuers: [] })).kind).toBe('invalid-token');
  });
  it('a project id must be a non-empty alphanumeric string', () => {
    const o = { logger: captureLogger().logger, clock: new SyncedClock(0) };
    expect(() => createDescopeVerifier({ projectId: '', ...o })).toThrow('required');
    expect(() => createDescopeVerifier({ projectId: undefined as unknown as string, ...o })).toThrow('required');
    expect(() => createDescopeVerifier({ projectId: 'a-b', ...o })).toThrow('alphanumeric');
    expect(() => createDescopeVerifier({ projectId: 'x'.repeat(129), ...o })).toThrow('alphanumeric');
    expect(() => createDescopeVerifier({ projectId: 'x'.repeat(128), ...o }).close()).not.toThrow();
  });
  it.each([
    ['credentials', 'https://u:p@auth.example.com', /credentials, query or fragment/],
    ['a query', 'https://auth.example.com?x=1', /credentials, query or fragment/],
    ['a fragment', 'https://auth.example.com#x', /credentials, query or fragment/],
    ['plain http to a named host', 'http://auth.example.com', /https/],
    ['a non-http scheme', 'ftp://127.0.0.1', /https/],
    ['text that is not a URL', 'nonsense', /not a valid URL/],
  ])('a baseUrl with %s is refused with a reason that names the rule', (_n, baseUrl, message) => {
    expect(() => createDescopeVerifier({ projectId: PID, baseUrl, logger: captureLogger().logger, clock: new SyncedClock(0) })).toThrow(message);
  });
});

describe('token claims and sizes', () => {
  it('expiresAt is exp in milliseconds with and without a profile', async () => {
    expect(await verify({})).toEqual({ kind: 'ok', userId: 'U2user', expiresAt: (T0 + 600) * 1000 });
    expect(await verify({ email: 'a@example.com', name: 'Ann', emailVerified: true })).toMatchObject({ kind: 'ok', expiresAt: (T0 + 600) * 1000, profile: { email: 'a@example.com' } });
  });
  it.each([
    ['unit separator', 'U2\u001fx'],
    ['application program command (C1 end)', 'U2\u009fx'],
  ])('a sub containing the %s control character is refused', async (_n, sub) => {
    expect((await verify({ sub })).kind).toBe('invalid-token');
  });
  it('a sub with an inner space or a no-break space is accepted (not control characters)', async () => {
    expect((await verify({ sub: 'U2 x' })).kind).toBe('ok');
    expect((await verify({ sub: 'U2\u00a0x' })).kind).toBe('ok');
  });
  it('a token of exactly 8192 characters is verified and a longer one is refused unread', async () => {
    // Pad a claim until the token length hits the target (base64 grows in steps, so the first length at or above it).
    const tokenAtLeast = async (len: number): Promise<string> => {
      let pad = Math.floor((len - 600) * 0.75);
      for (;;) {
        const t = await sign(pair, 'SK1', claims({ pad: 'a'.repeat(pad) }));
        if (t.length >= len) return t;
        pad += Math.max(1, Math.floor((len - t.length) * 0.7));
      }
    };
    const exact = await tokenAtLeast(8192);
    expect(exact).toHaveLength(8192);
    expect((await make().v.verify(exact)).kind).toBe('ok');
    server.requests = 0;
    const longer = await tokenAtLeast(8193);
    expect(longer.length).toBeGreaterThan(8192);
    expect((await make().v.verify(longer)).kind).toBe('invalid-token');
    expect(server.requests).toBe(0);
  });
  it('an empty token is refused without a request', async () => {
    expect(await make().v.verify('')).toEqual({ kind: 'invalid-token' });
    expect(server.requests).toBe(0);
  });
  it('a token with a header and payload but no signature is refused', async () => {
    expect((await make().v.verify(`${b64({ alg: 'RS256', kid: 'SK1' })}.${b64(claims())}.`)).kind).toBe('invalid-token');
  });
});

describe('profile claims inside a verified token', () => {
  const profileOf = async (extra: Record<string, unknown>) => {
    const r = await verify(extra);
    expect(r.kind).toBe('ok');
    return r.kind === 'ok' ? r.profile : undefined;
  };
  const base = { email: 'a@example.com', name: 'Ann', emailVerified: true };
  it('email of 320 characters is kept and 321 gives no profile', async () => {
    expect((await profileOf({ ...base, email: `${'e'.repeat(314)}@x.org` }))?.email).toHaveLength(320);
    expect(await profileOf({ ...base, email: `${'e'.repeat(315)}@x.org` })).toBeUndefined();
  });
  it('name of 200 characters is kept and 201 gives no profile; an empty name becomes the email', async () => {
    expect((await profileOf({ ...base, name: 'n'.repeat(200) }))?.name).toHaveLength(200);
    expect(await profileOf({ ...base, name: 'n'.repeat(201) })).toBeUndefined();
    expect((await profileOf({ ...base, name: '' }))?.name).toBe('a@example.com');
  });
  it.each([
    ['an empty email', { ...base, email: '' }],
    ['a numeric email', { ...base, email: 5 }],
    ['a numeric name', { ...base, name: 5 }],
    ['a string emailVerified', { ...base, emailVerified: 'true' }],
    ['no emailVerified', { email: 'a@example.com', name: 'Ann' }],
  ])('%s gives no profile but the token is still verified', async (_n, extra) => {
    expect(await profileOf(extra)).toBeUndefined();
  });
  it('an avatar is kept only when https and at most 2048 characters', async () => {
    const url = (n: number) => `https://i.example.com/${'a'.repeat(n - 'https://i.example.com/'.length)}`;
    expect((await profileOf({ ...base, picture: url(2048) }))?.avatarUrl).toHaveLength(2048);
    expect(await profileOf({ ...base, picture: url(2049) })).toEqual({ email: 'a@example.com', name: 'Ann', emailVerified: true });
    expect(await profileOf({ ...base, picture: 5 })).toEqual({ email: 'a@example.com', name: 'Ann', emailVerified: true });
  });
});

describe('management profile lookup', () => {
  let stub: Server;
  let body = '';
  let status = 200;
  let hang = false;
  let requests = 0;
  let stubUrl = '';
  beforeEach(async () => {
    stub = createServer((_req, res) => { requests += 1; if (hang) return; res.writeHead(status, { 'content-type': 'application/json' }).end(body); });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    status = 200;
    hang = false;
    requests = 0;
  });
  afterEach(async () => {
    stub.closeAllConnections();
    await new Promise<void>((r) => stub.close(() => r()));
  });
  const lookup = async (user: unknown, id = 'U2user') => {
    body = JSON.stringify({ user });
    const { v, lines } = make({ baseUrl: stubUrl, managementKey: 'K' });
    return { r: await v.profile(id), lines };
  };
  const failReasons = (lines: ReturnType<typeof captureLogger>['lines']) => lines.filter((l) => l.event === 'auth.profile_failed').map((l) => l.fields);
  const ann = { email: 'a@example.com', name: 'Ann', verifiedEmail: true };

  it('a good user is ok; verifiedEmail must be literally true', async () => {
    expect((await lookup(ann)).r).toEqual({ kind: 'ok', profile: { email: 'a@example.com', name: 'Ann', emailVerified: true } });
    expect((await lookup({ ...ann, verifiedEmail: 'true' })).r).toEqual({ kind: 'ok', profile: { email: 'a@example.com', name: 'Ann', emailVerified: false } });
  });
  it('a missing name falls back to the email', async () => {
    expect((await lookup({ email: 'a@example.com' })).r).toEqual({ kind: 'ok', profile: { email: 'a@example.com', name: 'a@example.com', emailVerified: false } });
  });
  it.each([
    ['no user', undefined],
    ['a user that is a list', []],
    ['no email', { name: 'Ann' }],
    ['an empty email', { ...ann, email: '' }],
    ['a numeric email', { ...ann, email: 5 }],
    ['an email of 321 characters', { ...ann, email: `${'e'.repeat(315)}@x.org` }],
    ['a name of 201 characters', { ...ann, name: 'n'.repeat(201) }],
  ])('%s is unavailable and logged as invalid', async (_n, user) => {
    const { r, lines } = await lookup(user);
    expect(r).toEqual({ kind: 'unavailable' });
    expect(failReasons(lines)).toEqual([{ reason: 'invalid' }]);
  });
  it('an email of 320 characters is accepted', async () => {
    expect((await lookup({ ...ann, email: `${'e'.repeat(314)}@x.org` })).r.kind).toBe('ok');
  });
  it('a user id of 256 characters is looked up and one of 257 is unavailable without a request', async () => {
    expect((await lookup(ann, 'u'.repeat(256))).r.kind).toBe('ok');
    const { r, lines } = await lookup(ann, 'u'.repeat(257));
    expect(r).toEqual({ kind: 'unavailable' });
    expect(failReasons(lines)).toEqual([]);
  });
  it('an answer other than 200 is unavailable and logged as http, even when it carries a good user', async () => {
    status = 203;
    const { r, lines } = await lookup(ann);
    expect(r).toEqual({ kind: 'unavailable' });
    expect(failReasons(lines)).toEqual([{ reason: 'http' }]);
  });
  it('a profile body that is not JSON is logged as invalid', async () => {
    body = '<html>';
    const { v, lines } = make({ baseUrl: stubUrl, managementKey: 'K' });
    expect(await v.profile('U2user')).toEqual({ kind: 'unavailable' });
    expect(failReasons(lines)).toEqual([{ reason: 'invalid' }]);
  });
  it('a user id that is not a string is unavailable without a request', async () => {
    const { r } = await lookup(ann, 123 as unknown as string);
    expect(r).toEqual({ kind: 'unavailable' });
    expect(requests).toBe(0);
  });
  it('a server that never answers is logged as a timeout, one that is not listening as a network failure', async () => {
    hang = true;
    const slow = make({ baseUrl: stubUrl, managementKey: 'K', fetchTimeoutMs: 50 });
    expect(await slow.v.profile('U2user')).toEqual({ kind: 'unavailable' });
    expect(failReasons(slow.lines)).toEqual([{ reason: 'timeout' }]);
    const down = make({ baseUrl: 'http://127.0.0.1:1', managementKey: 'K' });
    expect(await down.v.profile('U2user')).toEqual({ kind: 'unavailable' });
    expect(failReasons(down.lines)).toEqual([{ reason: 'network' }]);
  });
  it('a profile body over 64 KiB is refused', async () => {
    const { r } = await lookup({ ...ann, pad: 'x'.repeat(64 * 1024) });
    expect(r).toEqual({ kind: 'unavailable' });
  });
});
