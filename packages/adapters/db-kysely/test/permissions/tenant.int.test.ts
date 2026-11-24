import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { createMigratedDatabase, dropDatabase, loadTenantWorld, tenantFailures, TENANTS, urlFor } from './support.js';

// docs/tenancy.md 3.3 and 3.4, section 7 item 2: the facts carry the tenant of the user and of the page (or collection), and a collection of another tenant is not there.
const DB = `grimoire_tenancy_access_${String(process.pid)}`;
const { userA: USER_A, userB: USER_B, colA: COL_A, colB: COL_B, pageA: PAGE_A, pageB: PAGE_B } = TENANTS;
let db: KyselyDatabase;

beforeAll(async () => {
  await createMigratedDatabase(DB);
  await loadTenantWorld(DB);
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

  it('is wrong nowhere on the whole two-tenant check', async () => {
    expect(await tenantFailures(createAccessStore(db))).toBe(0);
  });
});
