import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

// docs/tenancy.md section 7, surfaces 1 and 5 (API, pages, history and trash): a person of one tenant meets every page, revision and trash entry of another tenant as one that
// is not there (404, never 403), lists their own only, and what they create belongs to their own tenant.
const PEOPLE = [{ name: 'boss-a', tenant: 'T-a', role: 'admin' }, { name: 'boss-b', tenant: 'T-b', role: 'admin' }, { name: 'member-b', tenant: 'T-b', role: 'member' }] as const;

function build() {
  const t = makeContext();
  const world = emptyWorld();
  const rows: UserRecord[] = PEOPLE.map((p, i) => ({ id: `00000000-0000-4000-8000-00000000060${String(i)}`, descopeUserId: `d-${p.name}`, email: `${p.name}@example.com`, name: p.name, role: p.role, suspended: false, tenantId: p.tenant }));
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
  const theirs = pages.seed({ collectionId: docsA.id, title: 'Secret', markdown: '# Secret', tenantId: 'T-a' });
  const mine = pages.seed({ collectionId: docsB.id, title: 'Mine', tenantId: 'T-b' });
  const trash = new FakeTrashRepo(world);
  const binnedA = trash.seedDeleted({ collectionId: docsA.id, title: 'Binned a', tenantId: 'T-a' });
  const binnedB = trash.seedDeleted({ collectionId: docsB.id, title: 'Binned b', tenantId: 'T-b' });
  const revisions = new FakeRevisionRepo();
  revisions.pageTenants.set(theirs.id, 'T-a');
  revisions.pageTenants.set(mine.id, 'T-b');
  const revisionA = revisions.seed({ pageId: theirs.id, createdAt: 1 });
  const revisionB = revisions.seed({ pageId: mine.id, createdAt: 1 });
  const store = createFakeAccessStore(world);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, collections, pages, trash, revisions, audit: trash.audit, idempotency: new FakeIdempotencyStore(t.clock), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer tok-${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, world, pages, trash, docsA, docsB, theirs, mine, binnedA, binnedB, revisionA, revisionB };
}

describe('the page, history and trash routes across tenants', () => {
  it('answers 404 to an administrator and a member of another tenant on every route of a page, its history and its trash entry', async () => {
    const b = build();
    const page = `/v1/pages/${b.theirs.id}`;
    const routes: [string, string, unknown?][] = [
      ['GET', page], ['GET', `/v1/pages/by-url-id/${b.theirs.urlId}`], ['PATCH', page, { title: 'Renamed' }], ['POST', `${page}/move`, { parentId: null }], ['DELETE', page],
      ['GET', `${page}/markdown`], ['GET', `${page}/revisions`], ['GET', `${page}/revisions/${b.revisionA.id}`], ['POST', `${page}/revisions/${b.revisionA.id}/restore`],
      ['POST', `${page}/reset-state`, {}], ['POST', `/v1/trash/${b.binnedA}/restore`], ['POST', '/v1/pages', { collectionId: b.docsA.id, title: 'Intruder' }],
      ['POST', `/v1/pages/${b.mine.id}/move`, { collectionId: b.docsA.id, parentId: null }],
    ];
    for (const who of ['boss-b', 'member-b']) {
      for (const [method, path, body] of routes) expect([who, method, path, (await b.call(who, method, path, body)).status]).toEqual([who, method, path, 404]);
    }
    expect((await b.call('boss-b', 'DELETE', `/v1/trash/${b.binnedA}`)).status).toBe(404);
    expect(b.trash.state(b.binnedA)).toBe('deleted');
    expect(b.pages.count()).toBe(2);
    expect((await b.call('boss-a', 'GET', page)).status).toBe(200);
  });

  it('lists a tenant its own trash and history only', async () => {
    const b = build();
    const trashIds = async (who: string, query = '') => ((await (await b.call(who, 'GET', `/v1/trash${query}`)).json()) as { items: { id: string }[] }).items.map((r) => r.id);
    expect(await trashIds('boss-b')).toEqual([b.binnedB]);
    expect(await trashIds('boss-b', `?collectionId=${b.docsA.id}`)).toEqual([]);
    expect(await trashIds('member-b')).toEqual([b.binnedB]);
    expect(await trashIds('boss-a')).toEqual([b.binnedA]);
    const history = (await (await b.call('member-b', 'GET', `/v1/pages/${b.mine.id}/revisions`)).json()) as { items: { id: string }[] };
    expect(history.items.map((r) => r.id)).toEqual([b.revisionB.id]);
  });

  it('creates a page in the caller\'s own tenant, which that tenant reads and the other does not', async () => {
    const b = build();
    const res = await b.call('member-b', 'POST', '/v1/pages', { collectionId: b.docsB.id, title: 'New' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(b.world.pages.find((p) => p.id === id)?.tenantId).toBe('T-b');
    expect((await b.call('member-b', 'GET', `/v1/pages/${id}`)).status).toBe(200);
    expect((await b.call('boss-a', 'GET', `/v1/pages/${id}`)).status).toBe(404);
    expect((await b.call('boss-b', 'POST', `/v1/trash/${b.binnedB}/restore`)).status).toBe(200);
  });
});
