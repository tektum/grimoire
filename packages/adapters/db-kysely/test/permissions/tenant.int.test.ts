import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { createMigratedDatabase, dropDatabase, loadWorld, sqlAs, urlFor } from './support.js';

// docs/tenancy.md 3.3 and 3.4, section 7 item 2: the facts carry the tenant of the user and of the page (or collection), and a collection of another tenant is not there.
const DB = `grimoire_tenancy_access_${String(process.pid)}`;
const id = (n: number): string => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const [USER_A, USER_B, COL_A, COL_B, PAGE_A, PAGE_B] = [id(1), id(2), id(3), id(4), id(5), id(6)] as [string, string, string, string, string, string];
const world: World = {
  users: [{ id: USER_A, role: 'admin', suspended: false }, { id: USER_B, role: 'admin', suspended: false }],
  groups: [], members: [], access: [],
  collections: [{ id: COL_A, deleted: false, defaultPermission: 'read_write' }, { id: COL_B, deleted: false, defaultPermission: 'read_write' }],
  pages: [{ id: PAGE_A, collectionId: COL_A, epoch: 1, deleted: false }, { id: PAGE_B, collectionId: COL_B, epoch: 1, deleted: false }],
};
let db: KyselyDatabase;

beforeAll(async () => {
  await createMigratedDatabase(DB);
  await loadWorld(DB, world);
  // Everything loads into the tenant `legacy`; tenant B takes its user, collection and page in one transaction (the keys between them are checked at commit).
  await sqlAs(urlFor('grimoire_admin', DB), `insert into tenants (id, name) values ('tenant-b', 'B')`);
  const admin = urlFor('grimoire_admin', DB);
  await sqlAs(admin, `begin; set constraints all deferred;
    update users set tenant_id = 'tenant-b' where id = '${USER_B}';
    update collections set tenant_id = 'tenant-b' where id = '${COL_B}';
    update pages set tenant_id = 'tenant-b' where id = '${PAGE_B}';
    commit;`);
  db = createDatabase(urlFor('grimoire_app', DB));
}, 180_000);
afterAll(async () => {
  await db.close();
  await dropDatabase(DB);
});

describe('tenants in the facts and in the decision (PostgreSQL)', () => {
  it('reads the tenant of the user and of the page', async () => {
    const facts = await createAccessStore(db).facts([{ userId: USER_A, pageId: PAGE_A }, { userId: USER_B, pageId: PAGE_B }, { userId: USER_A, pageId: PAGE_B }]);
    expect(facts.map((f) => [f.user?.tenantId, f.page?.tenantId])).toEqual([['legacy', 'legacy'], ['tenant-b', 'tenant-b'], ['legacy', 'tenant-b']]);
  });

  it('gives a user nothing on a page of another tenant (not found, as a page that is not there), and everything on its own', async () => {
    const authorizer = createAuthorizer(createAccessStore(db));
    expect((await authorizer.check({ userId: USER_A, pageId: PAGE_B })).access).toBe('none');
    expect((await authorizer.check({ userId: USER_B, pageId: PAGE_A })).access).toBe('none');
    expect((await authorizer.check({ userId: USER_A, pageId: PAGE_A })).access).toBe('read-write');
    expect((await authorizer.check({ userId: USER_B, pageId: PAGE_B })).access).toBe('read-write');
  });

  it('lists to a user only the collections of its own tenant (an admin of A does not see B\'s)', async () => {
    const store = createAccessStore(db);
    expect((await store.visibleCollections(USER_A)).map((c) => c.collectionId).sort()).toContain(COL_A);
    expect((await store.visibleCollections(USER_A)).map((c) => c.collectionId)).not.toContain(COL_B);
    expect((await store.visibleCollections(USER_B)).map((c) => c.collectionId)).toEqual([COL_B]);
    const facts = await store.collectionFacts([{ userId: USER_A, collectionId: COL_B }]);
    expect([facts[0]?.user?.tenantId, facts[0]?.collection?.tenantId]).toEqual(['legacy', 'tenant-b']);
  });
});
