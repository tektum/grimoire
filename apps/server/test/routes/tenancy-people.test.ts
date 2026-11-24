import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAdminRepo } from '@tektum/grimoire-core/testing/fake-admin-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

// docs/tenancy.md section 7, surface 6 (people and groups), through the routes: an administrator of one tenant sees, changes and reaches nobody and nothing of another.
const id = (n: number) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, '0')}`;
const PEOPLE = [
  { name: 'boss-a', role: 'admin', tenant: 'T-a' }, { name: 'amy-a', role: 'member', tenant: 'T-a' },
  { name: 'boss-b', role: 'admin', tenant: 'T-b' }, { name: 'bea-b', role: 'member', tenant: 'T-b' },
] as const;

function build() {
  const t = makeContext();
  const world = emptyWorld();
  const rows: UserRecord[] = PEOPLE.map((p, i) => ({ id: id(i), descopeUserId: `d-${p.name}`, email: `${p.name}@example.com`, name: p.name, role: p.role, suspended: false, tenantId: p.tenant }));
  const verifier: AuthVerifier = {
    verify: (token) => {
      const row = rows.find((r) => `tok-${r.name}` === token);
      return Promise.resolve(row === undefined ? { kind: 'invalid-token' } : { kind: 'ok', userId: row.descopeUserId, expiresAt: 9e12, tenant: { kind: 'one', id: row.tenantId } });
    },
  };
  const admin = new FakeAdminRepo(rows.map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, suspended: false, tenantId: r.tenantId })));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: { ...t.ctx.http, users, admin, idempotency: new FakeIdempotencyStore(t.clock), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }), access: createPageAccess(store), authorizer: createAuthorizer(store) },
  });
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer tok-${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, admin };
}

const items = async (res: Response) => ((await res.json()) as { items: { id: string; name: string }[] }).items;

describe('the people and group routes across tenants', () => {
  it('lists only the people and the groups of the caller\'s tenant, and the same group name is free in the other', async () => {
    const { call } = build();
    expect((await call('boss-a', 'POST', '/v1/groups', { name: 'Design' })).status).toBe(201);
    expect((await call('boss-b', 'POST', '/v1/groups', { name: 'Design' })).status).toBe(201);
    expect((await call('boss-a', 'POST', '/v1/groups', { name: 'design' })).status).toBe(409);
    expect((await items(await call('boss-a', 'GET', '/v1/groups'))).length).toBe(1);
    expect((await items(await call('boss-a', 'GET', '/v1/users'))).map((u) => u.name)).toEqual(['amy-a', 'boss-a']);
    expect((await items(await call('boss-b', 'GET', '/v1/users'))).map((u) => u.name)).toEqual(['bea-b', 'boss-b']);
  });

  it('answers 404 to every operation on a group or a person of another tenant', async () => {
    const { call } = build();
    const made = await call('boss-a', 'POST', '/v1/groups', { name: 'Ops' });
    const group = ((await made.json()) as { id: string }).id;
    const mine = id(1); // amy-a
    const theirs = id(3); // bea-b
    const probes: [string, string, string, unknown?][] = [
      ['boss-b', 'PATCH', `/v1/groups/${group}`, { name: 'Stolen' }], ['boss-b', 'DELETE', `/v1/groups/${group}`], ['boss-b', 'GET', `/v1/groups/${group}/members`],
      ['boss-b', 'PUT', `/v1/groups/${group}/members/${theirs}`], ['boss-b', 'DELETE', `/v1/groups/${group}/members/${mine}`],
      ['boss-a', 'PUT', `/v1/groups/${group}/members/${theirs}`], ['boss-a', 'PATCH', `/v1/users/${theirs}`, { role: 'viewer' }],
      ['boss-b', 'PATCH', `/v1/users/${mine}`, { role: 'viewer' }],
    ];
    for (const [who, method, path, payload] of probes) expect((await call(who, method, path, payload)).status, `${who} ${method} ${path}`).toBe(404);
    expect((await items(await call('boss-a', 'GET', '/v1/groups')))[0]).toMatchObject({ name: 'Ops' });
  });

  it('resolves the names of the people of the caller\'s tenant only', async () => {
    const { call } = build();
    const res = await call('boss-a', 'POST', '/v1/users/names', { ids: [id(1), id(3)] });
    expect(res.status).toBe(200);
    expect((await items(res)).map((u) => u.id)).toEqual([id(1)]);
  });
});
