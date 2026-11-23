import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { AdminUser } from '@tektum/grimoire-core/ports/admin-repo';
import type { Role, UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAdminRepo } from '@tektum/grimoire-core/testing/fake-admin-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const id = (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
const PEOPLE: [string, Role][] = [['admin', 'admin'], ['member', 'member'], ['viewer', 'viewer'], ['Zed', 'member'], ['amy', 'member']];
const NIL = '00000000-0000-4000-8000-000000000000';

/** Five people; the user store the sign-in step reads is a view over the same repo the routes change, as one table is in production. */
function build() {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const people: AdminUser[] = PEOPLE.map(([name, role], i) => ({ id: id(i), email: `${name.toLowerCase()}@example.com`, name, role, suspended: false }));
  const admin = new FakeAdminRepo(people);
  for (const p of people) world.users.push({ id: p.id, role: p.role, suspended: false });
  const base = new FakeUserStore();
  const users: UserStore = {
    createIfAbsent: (n) => base.createIfAbsent(n), updateRole: (i, r) => base.updateRole(i, r),
    findByDescopeId: (d) => {
      const row = people.find((p) => `d-${p.name}` === d);
      const live = row === undefined ? undefined : admin.find(row.id);
      return Promise.resolve(live === undefined ? undefined : ({ id: live.id, descopeUserId: d, email: live.email, name: live.name, role: live.role, suspended: live.suspended } satisfies UserRecord));
    },
  };
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, admin, idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string | undefined, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, admin };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const list = async (res: Response) => (await res.json()) as { items: { id: string; email: string; role: string }[]; nextCursor: string | null };

describe('admin routes of users: who may call', () => {
  it('answers 401 without a token and 403 to a member and a viewer, on every admin operation', async () => {
    const { call } = build();
    const routes: [string, string, unknown?][] = [['GET', '/v1/users'], ['PATCH', `/v1/users/${id(1)}`, { role: 'viewer' }]];
    for (const [method, path, body] of routes) {
      expect((await call(undefined, method, path, body)).status, `${method} ${path} anonymous`).toBe(401);
      for (const who of ['member', 'viewer']) expect((await call(who, method, path, body)).status, `${method} ${path} ${who}`).toBe(403);
    }
  });
});

describe('GET /v1/users', () => {
  it('pages by keyset in email order and ignores case in ?q', async () => {
    const { call } = build();
    const first = await list(await call('admin', 'GET', '/v1/users?limit=2'));
    expect(first.items.map((u) => u.email)).toEqual(['admin@example.com', 'amy@example.com']);
    const second = await list(await call('admin', 'GET', `/v1/users?limit=2&cursor=${first.nextCursor as string}`));
    expect(second.items.map((u) => u.email)).toEqual(['member@example.com', 'viewer@example.com']);
    const last = await list(await call('admin', 'GET', `/v1/users?limit=2&cursor=${second.nextCursor as string}`));
    expect(last.items.map((u) => u.email)).toEqual(['zed@example.com']);
    expect(last.nextCursor).toBeNull();
    expect((await list(await call('admin', 'GET', '/v1/users?q=ZED'))).items.map((u) => u.email)).toEqual(['zed@example.com']);
    expect((await list(await call('admin', 'GET', '/v1/users?q=AMY@EX'))).items).toHaveLength(1);
  });

  it('refuses a cursor that is not one of its own', async () => {
    const { call } = build();
    expect((await call('admin', 'GET', '/v1/users?cursor=bm90')).status).toBe(422);
    const forged = (keys: unknown[]) => Buffer.from(JSON.stringify({ l: 'users', k: keys }), 'utf8').toString('base64url');
    for (const keys of [['a@x', 1, ''], ['a@x', 'not-a-uuid', ''], [7, id(1), '']]) expect((await call('admin', 'GET', `/v1/users?cursor=${forged(keys)}`)).status, JSON.stringify(keys)).toBe(422);
  });

  it('refuses a cursor used with another search than the one that issued it', async () => {
    const { call } = build();
    const first = await list(await call('admin', 'GET', '/v1/users?limit=1&q=example'));
    expect(first.nextCursor).not.toBeNull();
    for (const query of ['q=amy', '']) expect((await call('admin', 'GET', `/v1/users?limit=1&${query}&cursor=${first.nextCursor as string}`)).status).toBe(422);
    expect((await call('admin', 'GET', `/v1/users?limit=1&q=example&cursor=${first.nextCursor as string}`)).status).toBe(200);
  });
});

describe('PATCH /v1/users/{id}', () => {
  it('publishes that a change needs at least one property', async () => {
    const doc = JSON.parse(readFileSync(new URL('../../../../packages/api-client/openapi.json', import.meta.url), 'utf8')) as { components: { schemas: { PatchUser: { minProperties?: number } } } };
    expect(doc.components.schemas.PatchUser.minProperties).toBe(1);
  });

  it('404 for an unknown user, 422 for a role outside the three and for an empty change', async () => {
    const { call } = build();
    expect(await code(await call('admin', 'PATCH', `/v1/users/${NIL}`, { role: 'viewer' }))).toBe('not_found');
    for (const body of [{ role: 'owner' }, {}, { role: 'viewer', extra: 1 }]) expect((await call('admin', 'PATCH', `/v1/users/${id(1)}`, body)).status).toBe(422);
  });

  it('changes the role and writes one audit row with ids and values only', async () => {
    const { call, admin } = build();
    const res = await call('admin', 'PATCH', `/v1/users/${id(1)}`, { role: 'viewer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: id(1), role: 'viewer', suspended: false });
    expect(admin.audit).toEqual([{ actorId: id(0), action: 'user.role_changed', targetType: 'user', targetId: id(1), detail: { from: 'member', to: 'viewer' } }]);
    expect(JSON.stringify(admin.audit)).not.toContain('@');
  });

  it('suspends at once, then unsuspends and restores the same user, one audit row each', async () => {
    const { call, admin } = build();
    expect((await call('member', 'GET', '/v1/users')).status).toBe(403);
    expect((await call('admin', 'PATCH', `/v1/users/${id(1)}`, { suspended: true })).status).toBe(200);
    const blocked = await call('member', 'POST', '/v1/users/names', { ids: [id(1)] });
    expect([blocked.status, await code(blocked)]).toEqual([403, 'account_suspended']);
    const back = await call('admin', 'PATCH', `/v1/users/${id(1)}`, { suspended: false });
    expect(await back.json()).toMatchObject({ id: id(1), suspended: false });
    expect((await call('member', 'POST', '/v1/users/names', { ids: [id(1)] })).status).toBe(200);
    expect(admin.audit.map((e) => e.action)).toEqual(['user.suspended', 'user.unsuspended']);
    expect(JSON.stringify(admin.audit)).not.toContain('@');
  });

  it('writes nothing when the value is already stored', async () => {
    const { call, admin } = build();
    expect((await call('admin', 'PATCH', `/v1/users/${id(1)}`, { role: 'member', suspended: false })).status).toBe(200);
    expect(admin.audit).toEqual([]);
  });

  it('409 last_admin for the only active administrator, demoted or suspended, and allows it once another exists', async () => {
    const { call, admin } = build();
    for (const body of [{ role: 'member' }, { suspended: true }]) expect(await code(await call('admin', 'PATCH', `/v1/users/${id(0)}`, body))).toBe('last_admin');
    expect(admin.find(id(0))).toMatchObject({ role: 'admin', suspended: false });
    expect((await call('admin', 'PATCH', `/v1/users/${id(1)}`, { role: 'admin' })).status).toBe(200);
    expect((await call('admin', 'PATCH', `/v1/users/${id(0)}`, { role: 'member' })).status).toBe(200);
  });
});

describe('POST /v1/users/names', () => {
  it('401 without a token; a viewer gets id and name only; unknown ids are omitted', async () => {
    const { call } = build();
    expect((await call(undefined, 'POST', '/v1/users/names', { ids: [id(1)] })).status).toBe(401);
    const res = await call('viewer', 'POST', '/v1/users/names', { ids: [id(1), NIL] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: id(1), name: 'member' }] });
  });

  it('422 for 0 and for 51 ids', async () => {
    const { call } = build();
    expect((await call('viewer', 'POST', '/v1/users/names', { ids: [] })).status).toBe(422);
    expect((await call('viewer', 'POST', '/v1/users/names', { ids: Array.from({ length: 51 }, (_, i) => id(i)) })).status).toBe(422);
  });

  it('answers 429 on the 61st call in 60 seconds', async () => {
    const { call } = build();
    for (let i = 0; i < 60; i += 1) expect((await call('viewer', 'POST', '/v1/users/names', { ids: [id(1)] })).status).toBe(200);
    expect((await call('viewer', 'POST', '/v1/users/names', { ids: [id(1)] })).status).toBe(429);
  });
});

describe('every route with the admin policy', () => {
  // A new route with `x-grimoire-policy` `admin` must be added here with a valid body, so a forgotten role check cannot ship.
  const VALID: Record<string, unknown> = {
    'GET /v1/users': undefined, 'PATCH /v1/users/{id}': { role: 'viewer' },
    'GET /v1/groups': undefined, 'POST /v1/groups': { name: 'x' }, 'PATCH /v1/groups/{id}': { name: 'y' }, 'DELETE /v1/groups/{id}': undefined,
    'GET /v1/groups/{id}/members': undefined, 'PUT /v1/groups/{id}/members/{userId}': undefined, 'DELETE /v1/groups/{id}/members/{userId}': undefined,
    'POST /v1/collections': { name: 'x' },
  };

  it('is listed in the table, and answers a member and a viewer 403', async () => {
    const doc = JSON.parse(readFileSync(new URL('../../../../packages/api-client/openapi.json', import.meta.url), 'utf8')) as {
      paths: Record<string, Record<string, { 'x-grimoire-policy'?: { kind: string } }>>;
    };
    const admin: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) if (op['x-grimoire-policy']?.kind === 'admin') admin.push(`${method.toUpperCase()} ${path}`);
    }
    expect(admin.sort()).toEqual(Object.keys(VALID).sort());
    const { call } = build();
    for (const key of admin) {
      const [method, template] = key.split(' ') as [string, string];
      const path = template.replace('{id}', id(1)).replace('{userId}', id(2));
      for (const who of ['member', 'viewer']) expect((await call(who, method, path, VALID[key])).status, `${key} ${who}`).toBe(403);
    }
  });
});
