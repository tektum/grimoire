import { describe, expect, it, vi } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

// docs/tenancy.md section 7, surface 1 (API, collections): an administrator of one tenant sees nothing of another tenant's collections, whatever the permission facts say, and what they
// create belongs to their own tenant.
const PEOPLE = [{ name: 'boss-a', tenant: 'T-a', role: 'admin' }, { name: 'boss-b', tenant: 'T-b', role: 'admin' }, { name: 'member-b', tenant: 'T-b', role: 'member' }] as const;

function build() {
  const t = makeContext();
  const world = emptyWorld();
  const rows: UserRecord[] = PEOPLE.map((p, i) => ({ id: `00000000-0000-4000-8000-00000000050${String(i)}`, descopeUserId: `d-${p.name}`, email: `${p.name}@example.com`, name: p.name, role: p.role, suspended: false, tenantId: p.tenant }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const verifier: AuthVerifier = {
    verify: (token) => {
      const row = rows.find((r) => `tok-${r.name}` === token);
      return Promise.resolve(row === undefined ? { kind: 'invalid-token' } : { kind: 'ok', userId: row.descopeUserId, expiresAt: 9e12, tenant: { kind: 'one', id: row.tenantId } });
    },
  };
  const users = new FakeUserStore(rows);
  const collections = new FakeCollectionRepo(world);
  const mine = collections.seed({ name: 'Docs', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read', tenantId: 'T-a' });
  const store = createFakeAccessStore(world);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: { ...t.ctx.http, users, collections, audit: collections.audit, idempotency: new FakeIdempotencyStore(t.clock), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }), access: createPageAccess(store), authorizer: createAuthorizer(store) },
  });
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer tok-${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, collections, mine, rows };
}

describe('the collection routes across tenants', () => {
  it('lists a tenant its own collections only', async () => {
    const { call, mine } = build();
    const ids = async (who: string) => ((await (await call(who, 'GET', '/v1/collections')).json()) as { items: { id: string }[] }).items.map((c) => c.id);
    expect(await ids('boss-a')).toEqual([mine.id]);
    expect(await ids('boss-b')).toEqual([]);
  });

  it('answers 404 to every operation of another tenant on a collection, its tree and its access', async () => {
    const { call, mine, collections } = build();
    const probes: [string, string, unknown?][] = [
      ['GET', `/v1/collections/${mine.id}`], ['PATCH', `/v1/collections/${mine.id}`, { name: 'Stolen' }], ['DELETE', `/v1/collections/${mine.id}`], ['GET', `/v1/collections/${mine.id}/tree`],
      ['GET', `/v1/collections/${mine.id}/access`],
    ];
    for (const [method, path, payload] of probes) expect((await call('boss-b', method, path, payload)).status, `${method} ${path}`).toBe(404);
    expect(await collections.get('T-a', mine.id)).toMatchObject({ name: 'Docs' });
    expect((await call('boss-a', 'GET', `/v1/collections/${mine.id}`)).status).toBe(200);
  });

  it('answers a person of another tenant 404, not 403, even when the collection is readable by default and the route needs more', async () => {
    const { call, mine } = build(); // `mine` is readable by everybody by default, in the permission facts
    for (const [method, path, payload] of [['PATCH', `/v1/collections/${mine.id}`, { name: 'x' }], ['DELETE', `/v1/collections/${mine.id}`], ['GET', `/v1/collections/${mine.id}/access`], ['PUT', `/v1/collections/${mine.id}/access`, { principalType: 'user', principalId: '00000000-0000-4000-8000-000000000001', permission: 'read' }], ['GET', `/v1/collections/${mine.id}/tree`]] as const) {
      expect((await call('member-b', method, path, payload)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('answers 404 when the collection is deleted after the access check and before the read or the change', async () => {
    const { call, mine, collections } = build();
    const real = collections.get.bind(collections);
    vi.spyOn(collections, 'get').mockImplementationOnce(real).mockResolvedValueOnce(undefined);
    expect((await call('boss-a', 'GET', `/v1/collections/${mine.id}`)).status).toBe(404);
    vi.spyOn(collections, 'update').mockResolvedValueOnce({ kind: 'not-found' });
    expect((await call('boss-a', 'PATCH', `/v1/collections/${mine.id}`, { name: 'Late' })).status).toBe(404);
  });

  it('creates a collection in the tenant of the caller', async () => {
    const { call, collections } = build();
    const res = await call('boss-b', 'POST', '/v1/collections', { name: 'Handbook' });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(await collections.get('T-b', id)).toMatchObject({ name: 'Handbook' });
    expect(await collections.get('T-a', id)).toBeUndefined();
  });
});
