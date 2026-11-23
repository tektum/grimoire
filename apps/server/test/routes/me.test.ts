import { describe, expect, it, vi } from 'vitest';
import type { AuthVerifier, Profile, ProfileResult, VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const TOKEN = 'tok-secret-123';
const PROFILE: Profile = { email: 'ann@example.com', name: 'Ann', emailVerified: true };

interface Setup { rows?: UserRecord[]; claims?: Profile; fetched?: ProfileResult; subject?: string; admins?: string[]; domains?: string[]; invalid?: boolean; local?: boolean; devRole?: 'admin' | 'viewer' | 'member' }

function build(s: Setup = {}) {
  const t = makeContext();
  const profile = vi.fn((): Promise<ProfileResult> => Promise.resolve(s.fetched ?? { kind: 'ok', profile: PROFILE }));
  const verifier: AuthVerifier = {
    verify: (): Promise<VerifyResult> =>
      Promise.resolve(s.invalid ? { kind: 'invalid-token' } : { kind: 'ok', userId: s.subject ?? 'd1', expiresAt: 9e12, ...(s.claims ? { profile: s.claims } : {}) }),
    profile,
  };
  const users = new FakeUserStore(s.rows ?? []);
  const signInPolicy = { firstAdminEmails: s.admins ?? [], allowedEmailDomains: s.domains ?? ['example.com'], allowDevRole: s.local ?? true };
  const provisioner = createProvisioner({ users, verifier, policy: signInPolicy, logger: t.logger });
  const roleOf = vi.fn(() => s.devRole);
  const config = { ...t.ctx.config, local: s.local ?? true };
  const app = createApp({ ...t.ctx, config, auth: { verifier, roles: { devOnly: true, roleOf } }, signInPolicy, http: { ...t.ctx.http, config, users, provisioner } });
  const me = () => app.request('/v1/me', { headers: { authorization: `Bearer ${TOKEN}` } });
  return { app, users, profile, me, roleOf };
}

const stored = (over: Partial<UserRecord> = {}): UserRecord => ({ id: 'u1', descopeUserId: 'd1', email: 'ann@example.com', name: 'Ann', role: 'member', suspended: false, ...over });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('GET /v1/me', () => {
  it('creates a member on the first call and returns the same user on the second', async () => {
    const { me, users } = build({ claims: PROFILE });
    const first = await me();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { id: string; email: string; name: string; role: string };
    expect(body).toMatchObject({ email: 'ann@example.com', name: 'Ann', role: 'member' });
    const second = (await (await me()).json()) as { id: string };
    expect(second.id).toBe(body.id);
    expect(users.all()).toHaveLength(1);
  });

  it('creates an admin for a listed first-admin email', async () => {
    const { me } = build({ claims: PROFILE, admins: ['ann@example.com'] });
    expect(((await (await me()).json()) as { role: string }).role).toBe('admin');
  });

  it('refuses without a token', async () => {
    const { app } = build();
    expect((await app.request('/v1/me')).status).toBe(401);
  });

  it('refuses a suspended user and returns no token anywhere', async () => {
    const { me } = build({ rows: [stored({ suspended: true })] });
    const res = await me();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('account_suspended');
    expect(text).not.toContain(TOKEN);
  });

  it('refuses a domain outside the list and an email held by another subject', async () => {
    const outside = build({ claims: { ...PROFILE, email: 'ann@other.test' } });
    const a = await outside.me();
    expect([a.status, await code(a)]).toEqual([403, 'not_allowed']);
    expect(outside.users.all()).toHaveLength(0);

    const taken = build({ rows: [stored({ descopeUserId: 'someone-else' })], claims: PROFILE });
    const b = await taken.me();
    expect([b.status, await code(b)]).toEqual([403, 'not_allowed']);
    expect(taken.users.all()).toHaveLength(1);
  });

  it.each([{ kind: 'unavailable' }, { kind: 'not-configured' }] as const)('answers 503 and writes no row when the profile is %j', async (fetched) => {
    const { me, users } = build({ fetched });
    const res = await me();
    expect([res.status, await code(res)]).toEqual([503, 'unavailable']);
    expect(users.all()).toHaveLength(0);
  });

  it('fetches the profile only for an unknown identity', async () => {
    const { me, profile } = build();
    expect((await me()).status).toBe(200);
    expect(profile).toHaveBeenCalledTimes(1);
    await me();
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it('re-checks a returning user: a claims domain no longer allowed is refused and the row is unchanged', async () => {
    const { me, users } = build({ rows: [stored()], claims: { ...PROFILE, email: 'ann@gone.test' } });
    const res = await me();
    expect([res.status, await code(res)]).toEqual([403, 'not_allowed']);
    expect(users.all()).toEqual([stored()]);
  });

  it('checks a returning user without claims by the stored email and fetches no profile', async () => {
    const ok = build({ rows: [stored()] });
    expect((await ok.me()).status).toBe(200);
    expect(ok.profile).not.toHaveBeenCalled();
    const gone = build({ rows: [stored({ email: 'ann@gone.test' })] });
    expect((await gone.me()).status).toBe(403);
    expect(gone.profile).not.toHaveBeenCalled();
  });

  it.each([
    ['http scheme', 'http://img.example.com/a.png'],
    ['credentials', 'https://u:p@img.example.com/a.png'],
    ['too long', `https://img.example.com/${'a'.repeat(2048)}`],
  ])('does not store an avatar address with %s', async (_n, avatarUrl) => {
    const { me, users } = build({ claims: { ...PROFILE, avatarUrl } });
    expect((await me()).status).toBe(200);
    expect(users.all()[0]?.avatarUrl).toBeUndefined();
  });

  it('stores a valid https avatar', async () => {
    const { me, users } = build({ claims: { ...PROFILE, avatarUrl: 'https://img.example.com/a.png' } });
    await me();
    expect(users.all()[0]?.avatarUrl).toBe('https://img.example.com/a.png');
  });

  it('creates one row for two simultaneous first calls', async () => {
    const { me, users } = build({ claims: PROFILE });
    const [a, b] = await Promise.all([me(), me()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(((await a.json()) as { id: string }).id).toBe(((await b.json()) as { id: string }).id);
    expect(users.all()).toHaveLength(1);
  });

  it('has no state endpoint', async () => {
    const { app } = build({ rows: [stored()] });
    const res = await app.request('/v1/pages/p1/state', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect([res.status, await code(res)]).toEqual([404, 'not_found']);
  });

  it('creates the user with the development role of the token in local mode', async () => {
    const { me } = build({ claims: PROFILE, devRole: 'viewer' });
    expect(((await (await me()).json()) as { role: string }).role).toBe('viewer');
  });

  it('syncs a changed development role of a returning user in local mode', async () => {
    const { me, users } = build({ rows: [stored()], devRole: 'admin' });
    expect(((await (await me()).json()) as { role: string }).role).toBe('admin');
    expect(users.all()[0]?.role).toBe('admin');
  });

  it('never consults the development role outside local mode', async () => {
    const created = build({ claims: PROFILE, devRole: 'admin', local: false });
    expect(((await (await created.me()).json()) as { role: string }).role).toBe('member');
    const returning = build({ rows: [stored()], devRole: 'admin', local: false });
    expect(((await (await returning.me()).json()) as { role: string }).role).toBe('member');
    expect(created.roleOf).not.toHaveBeenCalled();
    expect(returning.roleOf).not.toHaveBeenCalled();
  });

  it('refuses a user who is suspended by the time the provisioner reads the row', async () => {
    const { me, users } = build({ rows: [stored({ suspended: true })] });
    // The authentication step sees no row; the provisioner then finds the suspended one (a concurrent change).
    vi.spyOn(users, 'findByDescopeId').mockResolvedValueOnce(undefined);
    const res = await me();
    expect([res.status, await code(res)]).toEqual([403, 'account_suspended']);
  });

  it('refuses when the development role of a returning user cannot be stored', async () => {
    const { me, users } = build({ rows: [stored()], devRole: 'admin' });
    vi.spyOn(users, 'updateRole').mockResolvedValue(undefined);
    const res = await me();
    expect([res.status, await code(res)]).toEqual([403, 'not_allowed']);
  });
});
