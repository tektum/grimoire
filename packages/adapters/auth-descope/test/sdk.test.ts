import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { b64, captureLogger, goodClaims, KeyServer, makeKey, nowSec, PID, sign, SyncedClock, syncDate, type KeyPair } from './helpers.js';

// What the Descope SDK does not enforce, or does by itself, and the adapter's guard around it.
syncDate();

const keyServer = new KeyServer();
let pair: KeyPair;
let stub: Server;
let stubUrl = '';
let stubStatus = 200;
const stubPaths: string[] = [];

beforeEach(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  keyServer.requests = 0;
  keyServer.behaviour = 'ok';
  keyServer.keys = [k.jwk];
  await keyServer.start();
  stubPaths.length = 0;
  stubStatus = 200;
  stub = createServer((req, res) => {
    stubPaths.push(`${req.method ?? ''} ${req.url ?? ''}`);
    if ((req.url ?? '').startsWith('/v2/keys/')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: keyServer.keys })); return; }
    res.writeHead(stubStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { email: 'a@example.test', name: 'A', verifiedEmail: true } }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await keyServer.stop();
  stub.closeAllConnections();
  await new Promise<void>((r) => stub.close(() => r()));
});

const make = (baseUrl: string, o: Partial<Parameters<typeof createDescopeVerifier>[0]> = {}) =>
  createDescopeVerifier({ projectId: PID, baseUrl, logger: captureLogger().logger, clock: { now: () => Date.now() }, fetchTimeoutMs: 500, ...o });

describe('policy the SDK does not apply', () => {
  it('a listed issuer that is neither the project id nor a URL ending in it is still refused: the SDK check comes first and the list can only narrow it', async () => {
    const v = make(keyServer.url, { issuers: [PID, 'https://issuer.example/custom'] });
    expect((await v.verify(await sign(pair, 'SK1', goodClaims({ iss: 'https://issuer.example/custom' })))).kind).toBe('invalid-token');
    expect((await v.verify(await sign(pair, 'SK1', goodClaims()))).kind).toBe('ok');
  });
  it('an issuer that is a URL ending in the project id is refused (the SDK alone accepts it)', async () => {
    const v = make(keyServer.url);
    const url = await sign(pair, 'SK1', goodClaims({ iss: `https://api.descope.com/${PID}` }));
    const slashes = await sign(pair, 'SK1', goodClaims({ iss: `x/${PID}` }));
    expect(await v.verify(url)).toEqual({ kind: 'invalid-token' });
    expect(await v.verify(slashes)).toEqual({ kind: 'invalid-token' });
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok');
  });
  it('a configured issuer list is honoured exactly', async () => {
    const v = make(keyServer.url, { issuers: [`https://api.descope.com/${PID}`] });
    expect((await v.verify(await sign(pair, 'SK1', goodClaims({ iss: `https://api.descope.com/${PID}` })))).kind).toBe('ok');
    expect(await v.verify(await sign(pair, 'SK1'))).toEqual({ kind: 'invalid-token' });
  });
  it('PS256 and RS512 are refused before any key lookup: RS256 only', async () => {
    const v = make(keyServer.url);
    for (const alg of ['PS256', 'RS512']) {
      const t = `${b64({ alg, kid: 'SK1' })}.${b64(goodClaims())}.${b64('sig')}`; // the header alone must be enough to refuse
      expect(await v.verify(t), alg).toEqual({ kind: 'invalid-token' });
    }
    expect(keyServer.requests).toBe(0);
  });
  it('a token without exp, or without iat, is refused (the SDK does not require them)', async () => {
    const v = make(keyServer.url);
    const noExp = goodClaims();
    delete noExp['exp'];
    const noIat = goodClaims();
    delete noIat['iat'];
    expect(await v.verify(await sign(pair, 'SK1', noExp))).toEqual({ kind: 'invalid-token' });
    expect(await v.verify(await sign(pair, 'SK1', noIat))).toEqual({ kind: 'invalid-token' });
  });
});

describe('the transport guard around the SDK', () => {
  it('constructing with a management key makes no request at all (the SDK would start a licence handshake)', async () => {
    const v = make(stubUrl, { managementKey: 'key' });
    await v.verify(await sign(pair, 'SK1')); // fails (no keys there) but let any background call surface
    expect(stubPaths.filter((p) => !p.startsWith('GET /v2/keys/'))).toEqual([]);
    v.close();
  });
  it('a 503 from the key server is not retried by the SDK (one request, then the backoff)', async () => {
    keyServer.behaviour = { status: 503 };
    const v = make(keyServer.url);
    expect(await v.verify(await sign(pair, 'SK1'))).toEqual({ kind: 'service-unavailable' });
    expect(keyServer.requests).toBe(1);
  });
  it('a 503 from the load-user call is not retried and gives unavailable', async () => {
    stubStatus = 503;
    const v = make(stubUrl, { managementKey: 'key' });
    expect(await v.profile('U2user')).toEqual({ kind: 'unavailable' });
    expect(stubPaths).toEqual(['GET /v1/mgmt/user?userId=U2user']);
  });
  it('a token without a kid is invalid-token, not an outage', async () => {
    const v = make(keyServer.url);
    const t = await new SignJWT(goodClaims()).setProtectedHeader({ alg: 'RS256' }).sign(pair.privateKey);
    expect(await v.verify(t)).toEqual({ kind: 'invalid-token' });
  });
});

describe('time and keys on our side', () => {
  it('expiry and not-before follow the injected clock, not only the system clock the SDK uses', async () => {
    const ahead = make(keyServer.url, { clock: { now: () => Date.now() + 3_600_000 } });
    expect(await ahead.verify(await sign(pair, 'SK1'))).toEqual({ kind: 'invalid-token' }); // the SDK accepts it, our clock says it expired an hour ago
    const behind = make(keyServer.url, { clock: { now: () => Date.now() - 3_600_000 } });
    const t = await sign(pair, 'SK1', goodClaims({ iat: nowSec() - 7200, nbf: nowSec() }));
    expect(await behind.verify(t)).toEqual({ kind: 'invalid-token' }); // not yet valid on our clock
  });
  it('a key without a kid is not usable: a set of such keys is refused as a whole', async () => {
    const [first] = keyServer.keys;
    keyServer.keys = [Object.fromEntries(Object.entries(first ?? {}).filter(([k]) => k !== 'kid'))];
    expect(await make(keyServer.url).verify(await sign(pair, 'SK1'))).toEqual({ kind: 'service-unavailable' });
  });
  it('an empty key response is refused the same way', async () => {
    keyServer.behaviour = { raw: '' };
    expect(await make(keyServer.url).verify(await sign(pair, 'SK1'))).toEqual({ kind: 'service-unavailable' });
  });
});

describe('the boundaries of our own time rules, on the injected clock', () => {
  const MAX = 24 * 3600;
  /** A token minted relative to the (faked) system time, checked by a verifier whose clock is at a fixed offset from it, in ms. */
  const at = async (claims: Record<string, unknown>, offsetMs: number, o: { maxTokenLifetimeMs?: number } = {}) => {
    const v = make(keyServer.url, { clock: { now: () => Date.now() + offsetMs }, ...o });
    return (await v.verify(await sign(pair, 'SK1', goodClaims(claims)))).kind;
  };
  it('expiry: refused exactly when exp plus the 5 s tolerance is reached', async () => {
    const exp = nowSec() + 600;
    expect(await at({ exp }, exp * 1000 + 4999 - Date.now())).toBe('ok');
    expect(await at({ exp }, exp * 1000 + 5000 - Date.now())).toBe('invalid-token');
  });
  it('not before: refused exactly when nbf minus the 5 s tolerance is ahead of the clock', async () => {
    const nbf = nowSec();
    const iat = nbf - 100;
    expect(await at({ nbf, iat }, nbf * 1000 - 5000 - Date.now())).toBe('ok');
    expect(await at({ nbf, iat }, nbf * 1000 - 5001 - Date.now())).toBe('invalid-token');
  });
  it('remaining lifetime: a token issued 5 s ahead (tolerated) that lives exactly the maximum is refused, one second less is accepted', async () => {
    const iat = nowSec() + 5;
    expect(await at({ iat, exp: iat + MAX }, 0)).toBe('invalid-token');
    expect(await at({ iat, exp: iat + MAX - 5 }, 0)).toBe('ok');
  });
  it('a negative issued-at is refused', async () => {
    expect(await at({ iat: -10, exp: nowSec() + 600 }, 0)).toBe('invalid-token');
  });
  it('a negative issued-at is refused whatever the lifetime limit (a huge limit does not make it a valid lifetime)', async () => {
    expect(await at({ iat: -1, exp: nowSec() + 600 }, 0, { maxTokenLifetimeMs: 4e12 })).toBe('invalid-token');
  });
  it('a non-integer or string exp, iat, or nbf is refused', async () => {
    for (const claims of [{ exp: nowSec() + 600.5 }, { iat: nowSec() + 0.5 }, { nbf: 'x' }, { exp: String(nowSec() + 600) }]) expect(await at(claims, 0), JSON.stringify(claims)).toBe('invalid-token');
  });
});

describe('what only we can tell apart', () => {
  const MIN = 60_000;
  it('a failing load-user call does not turn an unknown kid into an outage, nor block key fetches', async () => {
    stubStatus = 503;
    const v = make(stubUrl, { managementKey: 'key', failureBackoffMs: 60_000 });
    expect(await v.profile('U2user')).toEqual({ kind: 'unavailable' });
    expect((await v.verify(await sign(pair, 'SK1'))).kind).toBe('ok'); // not blocked by a backoff the profile call would have started
    expect(await v.verify(await sign(pair, 'GHOST'))).toEqual({ kind: 'invalid-token' });
  });
  it('a bad signature or an expired token is invalid-token even while the key refresh is failing', async () => {
    const clock = new SyncedClock(Date.now());
    const v = make(keyServer.url, { clock });
    expect((await v.verify(await sign(pair, 'SK1', goodClaims({ exp: nowSec() + 24 * 3600 })))).kind).toBe('ok');
    await keyServer.stop();
    clock.advance(11 * MIN); // the SDK refreshes, the refresh fails, the old keys still serve
    const good = await sign(pair, 'SK1');
    const [h, p] = good.split('.');
    const other = await makeKey('SK1');
    const forged = await sign(other.pair, 'SK1');
    expect(await v.verify(forged)).toEqual({ kind: 'invalid-token' });
    expect(await v.verify(`${h}.${p}.${forged.split('.')[2]}`)).toEqual({ kind: 'invalid-token' });
    expect(await v.verify(await sign(pair, 'SK1', goodClaims({ exp: nowSec() - 60, iat: nowSec() - 600 })))).toEqual({ kind: 'invalid-token' });
    expect((await v.verify(good)).kind).toBe('ok');
  });
  it('a token without a kid while the keys are down is invalid-token (nothing to look up)', async () => {
    keyServer.behaviour = { status: 500 };
    const v = make(keyServer.url);
    expect(await v.verify(await sign(pair, 'SK1'))).toEqual({ kind: 'service-unavailable' });
    const t = await new SignJWT(goodClaims()).setProtectedHeader({ alg: 'RS256' }).sign(pair.privateKey);
    expect(await v.verify(t)).toEqual({ kind: 'invalid-token' });
  });
  it('anything that is not a string, and an empty string, is invalid-token', async () => {
    const v = make(keyServer.url);
    for (const t of [undefined, null, 5, {}, '', '.', 'a.b', 'a.b.c', '....']) expect(await v.verify(t as unknown as string), String(t)).toEqual({ kind: 'invalid-token' });
    expect(keyServer.requests).toBe(0);
  });
  it('key quality: a key with neither alg nor use is accepted; a key with a bad kid, modulus characters or exponent is not', async () => {
    const bare = Object.fromEntries(Object.entries(keyServer.keys[0] ?? {}).filter(([k]) => k !== 'alg' && k !== 'use'));
    keyServer.keys = [bare as never];
    expect((await make(keyServer.url).verify(await sign(pair, 'SK1'))).kind).toBe('ok');
    const n = String(bare['n']);
    for (const bad of [{ kid: '' }, { kid: 5 }, { n: `!${n}` }, { n: `${n}!` }, { n: 5 }, { e: 5 }, { e: '!AQAB' }]) {
      keyServer.keys = [{ ...bare, ...bad } as never];
      expect(await make(keyServer.url).verify(await sign(pair, 'SK1')), JSON.stringify(bad).slice(0, 20)).toEqual({ kind: 'service-unavailable' });
    }
  });
});

