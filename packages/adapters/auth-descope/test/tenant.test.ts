import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDescopeVerifier } from '../src/index.js';
import { captureLogger, goodClaims, KeyServer, makeKey, PID, sign, type KeyPair, SyncedClock, syncDate } from './helpers.js';

syncDate();

// The tenant a verified token names (docs/tenancy.md section 2.1): `dct` when it is one of the keys of `tenants`, the one key when there is no `dct`,
// nothing when there is no usable tenant, and "many" whenever `tenants` has more than one key, whatever `dct` says.
const T0 = 1_700_000_000;
const server = new KeyServer();
let pair: KeyPair;
const closers: Array<() => void> = [];

beforeEach(async () => {
  const k = await makeKey('SK1');
  pair = k.pair;
  server.requests = 0;
  server.behaviour = 'ok';
  server.keys = [k.jwk];
  await server.start();
});
afterEach(async () => {
  closers.splice(0).forEach((c) => c());
  await server.stop();
});

const tenantOf = async (extra: Record<string, unknown>) => {
  const v = createDescopeVerifier({ projectId: PID, baseUrl: server.url, logger: captureLogger().logger, clock: new SyncedClock(T0 * 1000), fetchTimeoutMs: 3000 });
  closers.push(() => v.close());
  const result = await v.verify(await sign(pair, 'SK1', goodClaims({ iat: T0, exp: T0 + 600, ...extra })));
  if (result.kind !== 'ok') throw new Error(`the token was refused: ${result.kind}`);
  return result.tenant;
};

describe('the tenant of a verified token', () => {
  it('is the current tenant when it is one of the tenants of the person', async () => {
    expect(await tenantOf({ tenants: { T1: {} }, dct: 'T1' })).toEqual({ kind: 'one', id: 'T1' });
  });

  it('is the one tenant when there is no current-tenant claim', async () => {
    expect(await tenantOf({ tenants: { T1: { roles: ['Tenant Admin'] } } })).toEqual({ kind: 'one', id: 'T1' });
  });

  it.each([
    ['no tenants claim', {}],
    ['an empty tenants map', { tenants: {} }],
    ['a tenants claim that is not a map', { tenants: ['T1'] }],
    ['a current tenant that is not one of the tenants', { tenants: { T1: {} }, dct: 'T2' }],
    ['a current tenant with no tenants', { dct: 'T1' }],
    ['a current tenant that is not text', { tenants: { T1: {} }, dct: 1 }],
    ['a tenant id with a character that is not allowed', { tenants: { 'T 1': {} } }],
    ['a tenant id that is too long', { tenants: { [`T${'1'.repeat(128)}`]: {} } }],
  ])('is none for %s', async (_name, extra) => {
    expect(await tenantOf(extra)).toEqual({ kind: 'none' });
  });

  it('is many when the person has more than one tenant, whatever the current-tenant claim says', async () => {
    expect(await tenantOf({ tenants: { T1: {}, T2: {} } })).toEqual({ kind: 'many' });
    expect(await tenantOf({ tenants: { T1: {}, T2: {} }, dct: 'T1' })).toEqual({ kind: 'many' });
  });
});
