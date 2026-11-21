import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, goodClaims, KeyServer, makeKey, PID, sign, type KeyPair } from './helpers.js';

const KEY = 'mgmt-key-SECRET-0123456789';
const keyServer = new KeyServer();
let pair: KeyPair;
let stub: Server;
let stubUrl = '';
let mode: 'ok' | 'hang' | 'status' | 'garbage' | 'redirect' | 'notfound' | 'huge' | 'noemail' | 'unverified' | 'nouser' = 'ok';
let target: Server;
let targetUrl = '';
const targetSeen: Array<{ url: string; auth: string | undefined }> = [];
const seen: Array<{ url: string; auth: string | undefined }> = [];
const clock = { now: (): number => Date.now() };

beforeAll(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  keyServer.keys = [k.jwk];
  await keyServer.start();
  stub = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (mode === 'hang') return;
    if (mode === 'redirect') { res.writeHead(302, { location: `${targetUrl}/stolen` }).end(); return; }
    if (mode === 'status') { res.writeHead(500).end('x'); return; }
    if (mode === 'garbage') { res.writeHead(200).end('<html>'); return; }
    if (mode === 'notfound') { res.writeHead(404).end('{}'); return; }
    if (mode === 'huge') { res.writeHead(200, { 'content-type': 'application/json' }).end(`{"user":{"email":"a@example.test","pad":"${'x'.repeat(70_000)}"}}`); return; }
    if (mode === 'noemail') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { userId: 'U2user', name: 'Ann' } })); return; }
    if (mode === 'nouser') { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
    if (mode === 'unverified') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { userId: 'U2user', email: 'ann@example.test', verifiedEmail: false } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { userId: 'U2user', email: 'Ann@Example.com', name: 'Ann', verifiedEmail: true, picture: 'https://img.example.com/a.png' } }));
  });
  target = createServer((req, res) => { targetSeen.push({ url: req.url ?? '', auth: req.headers.authorization }); res.writeHead(200).end('{}'); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  target.closeAllConnections();
  await new Promise<void>((r) => target.close(() => r()));
  stub.closeAllConnections();
  await new Promise<void>((r) => stub.close(() => r()));
  await keyServer.stop();
});

const make = (managementKey: string | undefined, base = stubUrl) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: base, managementKey, logger: cap.logger, clock, fetchTimeoutMs: 300 });
  return { v, lines: cap.lines };
};

describe('profile from signed claims', () => {
  const keyed = () => {
    const cap = captureLogger();
    return createDescopeVerifier({ projectId: PID, baseUrl: keyServer.url, logger: cap.logger, clock });
  };
  it('top-level email, name, emailVerified (and picture) come back in ok.profile', async () => {
    const v = keyed();
    const r = await v.verify(await sign(pair, 'SK1', goodClaims({ email: 'a@b.co', name: 'Ann', emailVerified: true, picture: 'https://img.example.com/a.png' })));
    v.close();
    expect(r).toMatchObject({ kind: 'ok', profile: { email: 'a@b.co', name: 'Ann', emailVerified: true, avatarUrl: 'https://img.example.com/a.png' } });
  });
  it('the same claims under nsec return no profile', async () => {
    const v = keyed();
    const r = await v.verify(await sign(pair, 'SK1', goodClaims({ nsec: { email: 'a@b.co', name: 'Ann', emailVerified: true } })));
    v.close();
    expect(r.kind).toBe('ok');
    expect(r).not.toHaveProperty('profile');
  });
  it.each([
    ['emailVerified as string', { email: 'a@b.co', name: 'A', emailVerified: 'true' }],
    ['email as number', { email: 5, name: 'A', emailVerified: true }],
    ['missing name', { email: 'a@b.co', emailVerified: true }],
    ['missing emailVerified', { email: 'a@b.co', name: 'A' }],
  ])('%s gives no profile but a valid result', async (_n, extra) => {
    const v = keyed();
    const r = await v.verify(await sign(pair, 'SK1', goodClaims(extra)));
    v.close();
    expect(r.kind).toBe('ok');
    expect(r).not.toHaveProperty('profile');
  });
  it('a non-https picture is dropped', async () => {
    const v = keyed();
    const r = await v.verify(await sign(pair, 'SK1', goodClaims({ email: 'a@b.co', name: 'A', emailVerified: true, picture: 'javascript:alert(1)' })));
    v.close();
    expect(r).toMatchObject({ kind: 'ok', profile: { email: 'a@b.co' } });
    expect(JSON.stringify(r)).not.toContain('javascript');
  });
});

describe('management profile lookup', () => {
  it('returns ok with the management API user, sending the documented path and bearer header', async () => {
    mode = 'ok';
    seen.length = 0;
    const { v } = make(KEY);
    expect(await v.profile?.('U2user')).toEqual({
      kind: 'ok',
      profile: { email: 'Ann@Example.com', name: 'Ann', emailVerified: true, avatarUrl: 'https://img.example.com/a.png' },
    });
    expect(seen).toEqual([{ url: '/v1/mgmt/user?userId=U2user', auth: `Bearer ${PID}:${KEY}` }]);
    v.close();
  });
  it('encodes the user id', async () => {
    mode = 'ok';
    seen.length = 0;
    const { v } = make(KEY);
    await v.profile?.('a&b=c/../d');
    expect(seen[0]?.url).toBe('/v1/mgmt/user?userId=a%26b%3Dc%2F..%2Fd');
    v.close();
  });
  it('is unavailable for HTTP 500, garbage, and a timeout; the key is in no log and no error', async () => {
    for (const m of ['status', 'garbage', 'hang'] as const) {
      mode = m;
      const { v, lines } = make(KEY);
      expect(await v.profile?.('U2user')).toEqual({ kind: 'unavailable' });
      expect(lines.some((l) => l.event === 'auth.profile_failed')).toBe(true);
      expect(JSON.stringify(lines)).not.toContain(KEY);
      v.close();
    }
  });
  it('never follows a redirect: the second server gets no request and no management key', async () => {
    mode = 'redirect';
    targetSeen.length = 0;
    const { v, lines } = make(KEY);
    expect(await v.profile?.('U2user')).toEqual({ kind: 'unavailable' });
    expect(targetSeen).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(KEY);
    v.close();
  });
  it('is unavailable when the server is unreachable and does not leak the key', async () => {
    const dead = new KeyServer();
    await dead.start();
    const url = dead.url;
    await dead.stop();
    const { v, lines } = make(KEY, url);
    expect(await v.profile?.('U2user')).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    v.close();
  });
  it('is not-configured without a key and makes no request', async () => {
    seen.length = 0;
    const { v } = make(undefined);
    expect(await v.profile?.('U2user')).toEqual({ kind: 'not-configured' });
    const { v: v2 } = make('');
    expect(await v2.profile?.('U2user')).toEqual({ kind: 'not-configured' });
    expect(seen).toEqual([]);
    v.close();
    v2.close();
  });
  it('an empty user id is unavailable without a request', async () => {
    seen.length = 0;
    const { v } = make(KEY);
    expect(await v.profile?.('')).toEqual({ kind: 'unavailable' });
    expect(seen).toEqual([]);
    v.close();
  });
});

describe('management profile lookup: the remaining cases', () => {
  it.each(['notfound', 'huge', 'noemail', 'nouser'] as const)('is unavailable when the answer is %s, with the reason logged and no key in the log', async (m) => {
    mode = m;
    const { v, lines } = make(KEY);
    expect(await v.profile?.('U2user')).toEqual({ kind: 'unavailable' });
    expect(lines.some((l) => l.event === 'auth.profile_failed')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(KEY);
    v.close();
  });
  it('maps an unverified email with no name: emailVerified false and the name falls back to the email', async () => {
    mode = 'unverified';
    const { v } = make(KEY);
    expect(await v.profile?.('U2user')).toEqual({ kind: 'ok', profile: { email: 'ann@example.test', name: 'ann@example.test', emailVerified: false } });
    v.close();
  });
  it('the documented query parameter is userId (camel case), per the provider documentation of the Load User endpoint', async () => {
    mode = 'ok';
    seen.length = 0;
    const { v } = make(KEY);
    await v.profile?.('U2user');
    expect(seen[0]?.url).toMatch(/^\/v1\/mgmt\/user\?userId=/);
    v.close();
  });
});
