import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { defaultTenantLimits, makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

// docs/tenancy.md section 3.8: a create or a restore past the tenant's cap of open pages (GRIMOIRE_TENANT_MAX_PAGES) answers 409 tenant_pages_full.
const PEOPLE = [{ name: 'member-a', tenant: 'T-a' }, { name: 'member-b', tenant: 'T-b' }] as const;

function build() {
  const t = makeContext();
  const world = emptyWorld();
  const rows: UserRecord[] = PEOPLE.map((p, i) => ({ id: `00000000-0000-4000-8000-00000000070${String(i)}`, descopeUserId: `d-${p.name}`, email: `${p.name}@example.com`, name: p.name, role: 'member', suspended: false, tenantId: p.tenant }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false, tenantId: r.tenantId as string });
  const verifier: AuthVerifier = {
    verify: (token) => {
      const row = rows.find((r) => `tok-${r.name}` === token);
      return Promise.resolve(row === undefined ? { kind: 'invalid-token' } : { kind: 'ok', userId: row.descopeUserId, expiresAt: 9e12, tenant: { kind: 'one', id: row.tenantId as string } });
    },
  };
  const users = new FakeUserStore(rows);
  const collections = new FakeCollectionRepo(world);
  const docsA = collections.seed({ name: 'Docs', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write', tenantId: 'T-a' });
  const docsB = collections.seed({ name: 'Docs', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write', tenantId: 'T-b' });
  const pages = new FakePageRepo(world);
  pages.collectionTenants.set(docsA.id, 'T-a');
  pages.collectionTenants.set(docsB.id, 'T-b');
  const trash = new FakeTrashRepo(world);
  const store = createFakeAccessStore(world);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const config = makeFakeConfig({ tenantLimits: { ...defaultTenantLimits, maxPages: 2 } });
  const app = createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, collections, pages, trash, audit: trash.audit, idempotency: new FakeIdempotencyStore(t.clock), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer tok-${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, pages, trash, docsA, docsB };
}

const FULL = { error: { code: 'tenant_pages_full', message: 'The workspace has reached its limit of pages.' } };

describe('the cap of open pages of a tenant on the API', () => {
  it('creates up to the cap from the settings, then answers 409 tenant_pages_full and creates nothing; another tenant still creates', async () => {
    const b = build();
    b.pages.seed({ collectionId: b.docsA.id, tenantId: 'T-a' });
    expect((await b.call('member-a', 'POST', '/v1/pages', { collectionId: b.docsA.id, title: 'Second' })).status).toBe(201);
    const full = await b.call('member-a', 'POST', '/v1/pages', { collectionId: b.docsA.id, title: 'Third' });
    expect([full.status, await full.json()]).toEqual([409, FULL]);
    expect(b.pages.count()).toBe(2);
    expect((await b.call('member-b', 'POST', '/v1/pages', { collectionId: b.docsB.id, title: 'Mine' })).status).toBe(201);
  });

  it('answers 409 tenant_pages_full to a restore past the cap and leaves the page in the trash; one that fits is restored', async () => {
    const b = build();
    b.trash.seedLive({ collectionId: b.docsA.id, tenantId: 'T-a' });
    const binned = b.trash.seedDeleted({ collectionId: b.docsA.id, tenantId: 'T-a' });
    expect((await b.call('member-a', 'POST', `/v1/trash/${binned}/restore`)).status).toBe(200);
    const over = b.trash.seedDeleted({ collectionId: b.docsA.id, tenantId: 'T-a' });
    const full = await b.call('member-a', 'POST', `/v1/trash/${over}/restore`);
    expect([full.status, await full.json()]).toEqual([409, FULL]);
    expect(b.trash.state(over)).toBe('deleted');
  });
});
