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
      return Promise.resolve(live === undefined ? undefined : ({ id: live.id, descopeUserId: d, email: live.email, name: live.name, role: live.role, suspended: live.suspended, tenantId: 'legacy' } satisfies UserRecord));
    },
  };
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, admin, idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string | undefined, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, admin };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;


const body = async (res: Response) => (await res.json()) as { items: { id: string; name: string; memberCount?: number; email?: string }[] };

async function makeGroup(call: ReturnType<typeof build>['call'], name: string): Promise<string> {
  const res = await call('admin', 'POST', '/v1/groups', { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('admin routes of groups: who may call', () => {
  it('answers 401 without a token and 403 to a member and a viewer, on every operation', async () => {
    const { call } = build();
    const group = await makeGroup(call, 'Writers');
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/groups'], ['POST', '/v1/groups', { name: 'x' }], ['PATCH', `/v1/groups/${group}`, { name: 'y' }], ['DELETE', `/v1/groups/${group}`],
      ['GET', `/v1/groups/${group}/members`], ['PUT', `/v1/groups/${group}/members/${id(1)}`], ['DELETE', `/v1/groups/${group}/members/${id(1)}`],
    ];
    for (const [method, path, payload] of routes) {
      expect((await call(undefined, method, path, payload)).status, `${method} ${path} anonymous`).toBe(401);
      for (const who of ['member', 'viewer']) expect((await call(who, method, path, payload)).status, `${method} ${path} ${who}`).toBe(403);
    }
  });
});

describe('groups', () => {
  it('creates, lists in name order ignoring case, renames and deletes, one audit row each, with no name in it', async () => {
    const { call, admin } = build();
    const writers = await makeGroup(call, 'writers');
    await makeGroup(call, 'Admins');
    expect((await body(await call('admin', 'GET', '/v1/groups'))).items.map((g) => g.name)).toEqual(['Admins', 'writers']);
    const renamed = await call('admin', 'PATCH', `/v1/groups/${writers}`, { name: ' Editors ' });
    expect(await renamed.json()).toMatchObject({ id: writers, name: 'Editors', memberCount: 0 });
    expect((await call('admin', 'DELETE', `/v1/groups/${writers}`)).status).toBe(204);
    expect(admin.audit.map((e) => e.action)).toEqual(['group.created', 'group.created', 'group.renamed', 'group.deleted']);
    expect(JSON.stringify(admin.audit)).not.toMatch(/@|writers|Editors|Admins/);
  });

  it('409 name_taken for a name that differs only in case, on create and on rename; renaming to its own name is fine', async () => {
    const { call } = build();
    const a = await makeGroup(call, 'Design');
    await makeGroup(call, 'Ops');
    expect(await code(await call('admin', 'POST', '/v1/groups', { name: 'DESIGN' }))).toBe('name_taken');
    expect(await code(await call('admin', 'PATCH', `/v1/groups/${a}`, { name: 'ops' }))).toBe('name_taken');
    expect((await call('admin', 'PATCH', `/v1/groups/${a}`, { name: 'design' })).status).toBe(200);
  });

  it('404 for an unknown group on every operation that names one, 422 for a bad name', async () => {
    const { call } = build();
    for (const [method, path, payload] of [
      ['PATCH', `/v1/groups/${NIL}`, { name: 'x' }], ['DELETE', `/v1/groups/${NIL}`], ['GET', `/v1/groups/${NIL}/members`],
      ['PUT', `/v1/groups/${NIL}/members/${id(1)}`], ['DELETE', `/v1/groups/${NIL}/members/${id(1)}`],
    ] as [string, string, unknown?][]) expect(await code(await call('admin', method, path, payload)), `${method} ${path}`).toBe('not_found');
    for (const name of ['', '   ', 'x'.repeat(101), 7]) expect((await call('admin', 'POST', '/v1/groups', { name })).status).toBe(422);
  });
});

describe('group members', () => {
  it('adds, lists with emails in email order, counts, and removes, one audit row each with ids only', async () => {
    const { call, admin } = build();
    const group = await makeGroup(call, 'Team');
    for (const user of [id(3), id(4)]) expect((await call('admin', 'PUT', `/v1/groups/${group}/members/${user}`)).status).toBe(204);
    expect((await body(await call('admin', 'GET', `/v1/groups/${group}/members`))).items.map((m) => m.email)).toEqual(['amy@example.com', 'zed@example.com']);
    expect((await body(await call('admin', 'GET', '/v1/groups'))).items[0]?.memberCount).toBe(2);
    expect((await call('admin', 'DELETE', `/v1/groups/${group}/members/${id(3)}`)).status).toBe(204);
    expect(admin.audit.filter((e) => e.action.startsWith('group.member')).map((e) => [e.action, e.detail])).toEqual([
      ['group.member_added', { userId: id(3) }], ['group.member_added', { userId: id(4) }], ['group.member_removed', { userId: id(3) }],
    ]);
    expect(JSON.stringify(admin.audit)).not.toContain('@');
  });

  it('adding a member twice changes nothing and writes one row; an unknown user is 404; removing a non-member is 404', async () => {
    const { call, admin } = build();
    const group = await makeGroup(call, 'Team');
    for (let i = 0; i < 2; i += 1) expect((await call('admin', 'PUT', `/v1/groups/${group}/members/${id(1)}`)).status).toBe(204);
    expect(admin.audit.filter((e) => e.action === 'group.member_added')).toHaveLength(1);
    expect(await code(await call('admin', 'PUT', `/v1/groups/${group}/members/${NIL}`))).toBe('not_found');
    expect(await code(await call('admin', 'DELETE', `/v1/groups/${group}/members/${id(2)}`))).toBe('not_found');
    expect((await call('admin', 'PUT', `/v1/groups/${group}/members/nope`)).status).toBe(422);
  });
});

describe('a create of a group with an Idempotency-Key', () => {
  it('makes one group for the same key and replays the answer', async () => {
    const { call, admin } = build();
    const post = () => call('admin', 'POST', '/v1/groups', { name: 'Once' }, { 'idempotency-key': 'k1' });
    const first = await post();
    const second = await post();
    expect([first.status, second.status, second.headers.get('idempotent-replay')]).toEqual([201, 201, 'true']);
    expect(await second.json()).toEqual(await first.json());
    expect((await admin.listGroups('legacy')).filter((g) => g.name === 'Once')).toHaveLength(1);
    expect(admin.audit.filter((e) => e.action === 'group.created')).toHaveLength(1);
  });

  it('is refused when the caller is no longer an administrator or the group is gone, and replays while both hold', async () => {
    const { call } = build();
    const post = (key: string) => call('admin', 'POST', '/v1/groups', { name: key }, { 'idempotency-key': key });
    const made = (await (await post('gone')).json()) as { id: string };
    expect((await post('gone')).headers.get('idempotent-replay')).toBe('true');
    await call('admin', 'DELETE', `/v1/groups/${made.id}`);
    expect((await post('gone')).status).toBe(404);
    await post('kept');
    await call('admin', 'PATCH', `/v1/users/${id(1)}`, { role: 'admin' });
    await call('admin', 'PATCH', `/v1/users/${id(0)}`, { role: 'member' });
    expect((await post('kept')).status).toBe(403);
  });
});
