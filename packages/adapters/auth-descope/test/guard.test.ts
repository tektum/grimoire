import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, KeyServer, makeKey, PID, sign, SyncedClock, syncDate } from './helpers.js';

// The real SDK is replaced here ONLY to reach the guarded `fetch` the adapter hands it, and to make it throw a chosen error.
const sdk = vi.hoisted(() => ({ fetch: undefined as undefined | ((u: string, i?: RequestInit) => Promise<Response>), throwing: undefined as unknown, probeKeys: false }));
vi.mock('@descope/node-sdk', () => ({
  default: (cfg: { fetch: (u: string, i?: RequestInit) => Promise<Response>; baseUrl: string }) => {
    sdk.fetch = cfg.fetch;
    return {
      validateJwt: async () => {
        if (sdk.probeKeys) await cfg.fetch(`${cfg.baseUrl}/v2/keys/${PID}`, { method: 'GET' }).catch(() => undefined);
        throw sdk.throwing;
      },
      management: { user: { loadByUserId: async () => ({ data: undefined }) } },
    };
  },
}));

syncDate();
const server = new KeyServer();
beforeEach(async () => {
  server.requests = 0;
  server.paths = [];
  server.behaviour = 'ok';
  server.keys = [(await makeKey('SK1')).jwk];
  sdk.probeKeys = false;
  await server.start();
});
afterEach(async () => { await server.stop(); });

const make = (clock = new SyncedClock(1_800_000_000_000)) => {
  const cap = captureLogger();
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: cap.logger, clock, fetchTimeoutMs: 300, managementKey: 'm' });
  return { v, clock, lines: cap.lines };
};

describe('guarded fetch: methods (F2)', () => {
  it('the key path accepts GET only: any other method is refused before any network call', async () => {
    make();
    const url = `${server.url}/v2/keys/${PID}`;
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH', undefined]) {
      await expect(sdk.fetch?.(url, method === undefined ? {} : { method })).rejects.toThrow();
    }
    await expect(sdk.fetch?.(url)).rejects.toThrow();
    expect(server.requests).toBe(0);
  });

  it('the load-user path accepts GET only: any other method is refused before any network call', async () => {
    make();
    const url = `${server.url}/v1/mgmt/user?userId=U1`;
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', undefined]) {
      await expect(sdk.fetch?.(url, method === undefined ? {} : { method })).rejects.toThrow();
    }
    expect(server.requests).toBe(0);
  });

  it('GET reaches both allowed paths', async () => {
    server.behaviour = { raw: '{"keys":[]}' };
    make();
    await expect(sdk.fetch?.(`${server.url}/v1/mgmt/user?userId=U1`, { method: 'GET' })).resolves.toBeInstanceOf(Response);
    expect(server.requests).toBe(1);
  });
});

describe('an unrecognised SDK error (F3c)', () => {
  const stub = Object.assign(new Error('secret-token-looking-text'), { name: 'WeirdSdkError' });

  it('is refused as invalid-token while the last key fetch is healthy, and logged once per cooldown by name only', async () => {
    sdk.throwing = stub;
    const { v, clock, lines } = make();
    const t = await sign((await makeKey('SK1')).pair, 'SK1');
    for (let i = 0; i < 5; i += 1) expect(await v.verify(t)).toEqual({ kind: 'invalid-token' });
    const logged = () => lines.filter((l) => l.event === 'auth.sdk_unexpected_error');
    expect(logged()).toHaveLength(1);
    expect(logged()[0]?.fields).toEqual({ name: 'WeirdSdkError' });
    expect(JSON.stringify(lines)).not.toContain(t);
    expect(JSON.stringify(lines)).not.toContain('secret-token-looking-text');
    clock.advance(30_001);
    await v.verify(t);
    expect(logged()).toHaveLength(2);
  });

  it('is refused as service-unavailable while the last key fetch failed', async () => {
    sdk.throwing = stub;
    sdk.probeKeys = true;
    server.behaviour = { status: 500 };
    const { v, lines } = make();
    const t = await sign((await makeKey('SK1')).pair, 'SK1');
    expect(await v.verify(t)).toEqual({ kind: 'service-unavailable' });
    expect(lines.some((l) => l.event === 'auth.sdk_unexpected_error')).toBe(true);
  });

  it('a thrown non-Error is also refused and logged by type', async () => {
    sdk.throwing = 'just a string';
    const { v, lines } = make();
    expect(await v.verify(await sign((await makeKey('SK1')).pair, 'SK1'))).toEqual({ kind: 'invalid-token' });
    expect(lines.find((l) => l.event === 'auth.sdk_unexpected_error')?.fields).toEqual({ name: 'string' });
  });
});
