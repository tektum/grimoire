import { describe, expect, it, vi } from 'vitest';
import type { AuthVerifier, VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import type { Identity } from '../../src/http/env.js';
import { makeContext } from '../server/support/context.js';

const TOKEN = 'tok-secret-123';
const row = (over: Partial<UserRecord> = {}): UserRecord => ({ id: 'u1', descopeUserId: 'd1', email: 'ann@example.com', name: 'Ann', role: 'member', suspended: false, tenantId: 'legacy', ...over });
const PROFILE = { email: 'ann@example.com', name: 'Ann', emailVerified: true };

interface Setup { rows?: UserRecord[]; result?: VerifyResult; domains?: string[] }

function build(s: Setup = {}) {
  const t = makeContext();
  const calls: string[] = [];
  const verifier: AuthVerifier = {
    verify: (token) => { calls.push(token); return Promise.resolve(s.result ?? { kind: 'ok', userId: 'd1', expiresAt: 9e12 }); },
    profile: () => Promise.resolve({ kind: 'ok', profile: PROFILE }),
  };
  const users = new FakeUserStore(s.rows ?? [row()]);
  const lookups = vi.spyOn(users, 'findByDescopeId');
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: s.domains ?? ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const provisioner = createProvisioner({ users, verifier, policy: signInPolicy, logger: t.logger });
  const ctx = { ...t.ctx, auth: { verifier }, signInPolicy, http: { ...t.ctx.http, users, provisioner } };
  const app = createApp(ctx);
  const seen: { identity: Identity | undefined; user: UserRecord | undefined }[] = [];
  const handler = (c: import('hono').Context<import('../../src/http/env.js').AppEnv>) => {
    seen.push({ identity: c.get('identity'), user: c.get('user') });
    return c.json({ ok: true });
  };
  app.get('/v1/config', handler);
  app.get('/v1/me', handler);
  app.get('/v1/things', handler);
  return { app, t, calls, seen, lookups };
}

const get = (app: ReturnType<typeof build>['app'], path: string, authorization?: string) =>
  app.request(path, { headers: authorization === undefined ? {} : { authorization } });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const rejected = (t: ReturnType<typeof build>['t']) => t.logger.entries.filter((e) => JSON.stringify(e).includes('http.auth_rejected')).map((e) => JSON.stringify(e));

describe('bearer authentication', () => {
  it('answers a public route without credentials and never calls the verifier', async () => {
    const { app, calls } = build();
    expect((await get(app, '/v1/config')).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('refuses a request with no credentials before any token work', async () => {
    const { app, t, calls } = build();
    const res = await get(app, '/v1/things');
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthenticated');
    expect(calls).toEqual([]);
    expect(rejected(t)[0]).toContain('missing');
  });

  it.each(['Basic abc', 'Bearer', 'Bearer ', 'Bearer a b', 'abc', 'Bearer  abc'])('refuses the malformed header %j as invalid', async (header) => {
    const { app, t, calls } = build();
    expect((await get(app, '/v1/things', header)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(rejected(t)[0]).toContain('invalid');
  });

  it('refuses a token the verifier rejects, and logs no token', async () => {
    const { app, t } = build({ result: { kind: 'invalid-token' } });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
    expect(rejected(t)[0]).toContain('invalid');
    expect(JSON.stringify(t.logger.entries)).not.toContain(TOKEN);
  });

  it('answers 503 when the verifier is unavailable', async () => {
    const { app } = build({ result: { kind: 'service-unavailable' } });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('unavailable');
  });

  it('accepts the scheme in any case and gives the handler the identity and the stored row', async () => {
    const { app, seen, calls } = build();
    expect((await get(app, '/v1/things', `bearer ${TOKEN}`)).status).toBe(200);
    expect(calls).toEqual([TOKEN]);
    expect(seen[0]?.identity).toEqual({ userId: 'd1' });
    expect(seen[0]?.user?.id).toBe('u1');
  });

  it('keeps the profile of the claims on the identity', async () => {
    const { app, seen } = build({ result: { kind: 'ok', userId: 'd1', expiresAt: 9e12, profile: PROFILE } });
    expect((await get(app, '/v1/things', `Bearer ${TOKEN}`)).status).toBe(200);
    expect(seen[0]?.identity?.profile).toEqual(PROFILE);
  });
});

describe('a verified identity without a row', () => {
  it('reaches GET /v1/me with the identity and no row', async () => {
    const { app, seen } = build({ rows: [] });
    // The real route answers: it provisions the unknown identity from the fetched profile.
    const res = await get(app, '/v1/me', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('ann@example.com');
    expect(seen).toEqual([]);
  });

  it('is 403 forbidden on every other route', async () => {
    const { app, t } = build({ rows: [] });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('forbidden');
    expect(rejected(t)[0]).toContain('no-user');
  });
});

describe('suspended and returning users', () => {
  it.each(['/v1/me', '/v1/things'])('refuses a suspended user on %s', async (path) => {
    const { app, t } = build({ rows: [row({ suspended: true })] });
    const res = await get(app, path, `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('account_suspended');
    expect(rejected(t)[0]).toContain('suspended');
  });

  it.each(['/v1/me', '/v1/things'])('refuses a user whose stored domain is no longer allowed on %s', async (path) => {
    const { app } = build({ rows: [row({ email: 'ann@removed.example' })] });
    const res = await get(app, path, `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('not_allowed');
  });

  it('logs the provisioner refusal once, as before', async () => {
    const { app, t } = build({ rows: [row({ email: 'ann@removed.example' })] });
    await get(app, '/v1/things', `Bearer ${TOKEN}`);
    const refused = t.logger.entries.filter((e) => e.event === 'users.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ level: 'warn', fields: { reason: 'domain-not-allowed' } });
  });

  it('refuses a suspended user with account_suspended even when the domain is no longer allowed', async () => {
    const { app } = build({ rows: [row({ suspended: true, email: 'ann@removed.example' })] });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('account_suspended');
  });

  it('refuses a returning user whose claims carry a profile outside the allowed domains', async () => {
    const outside = { ...PROFILE, email: 'ann@removed.example' };
    const { app } = build({ result: { kind: 'ok', userId: 'd1', expiresAt: 9e12, profile: outside } });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('not_allowed');
  });

  it.each([
    ['names another tenant than the row', { kind: 'one', id: 'T-other' }],
    ['names no tenant', { kind: 'none' }],
    ['names several tenants', { kind: 'many' }],
  ] as const)('refuses a returning user whose token %s, on every route, with not_allowed', async (_name, tenant) => {
    const { app, seen } = build({ result: { kind: 'ok', userId: 'd1', expiresAt: 9e12, tenant } });
    const res = await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('not_allowed');
    expect(seen).toEqual([]);
  });

  it('lets a returning user whose token names the tenant of the row through', async () => {
    const { app, seen } = build({ rows: [row({ tenantId: 'T-acme' })], result: { kind: 'ok', userId: 'd1', expiresAt: 9e12, tenant: { kind: 'one', id: 'T-acme' } } });
    expect((await get(app, '/v1/things', `Bearer ${TOKEN}`)).status).toBe(200);
    expect(seen[0]).toMatchObject({ identity: { tenant: { kind: 'one', id: 'T-acme' } }, user: { tenantId: 'T-acme' } });
  });

  it('lets a returning user of an allowed domain through, whatever the case of the stored address', async () => {
    const { app } = build({ rows: [row({ email: 'Ann@Example.COM' })] });
    expect((await get(app, '/v1/things', `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it('reads the row once per request, including the returning-user check', async () => {
    const { app, lookups } = build();
    expect((await get(app, '/v1/things', `Bearer ${TOKEN}`)).status).toBe(200);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(lookups).toHaveBeenCalledWith('d1');
  });

  it('does not create a row for an unknown identity on a plain route', async () => {
    const { app, seen } = build({ rows: [] });
    await get(app, '/v1/things', `Bearer ${TOKEN}`);
    expect(seen).toEqual([]);
    expect((await get(app, '/v1/me', `Bearer ${TOKEN}`)).status).toBe(200);
    expect(seen).toEqual([]);
  });
});
