import { describe, expect, it } from 'vitest';
import { createFakeAccessStore, emptyWorld } from '../../src/testing/fake-access-store.js';

// As the PostgreSQL store (db-kysely permissions.ts, `u.tenant_id = $tenant`): asked for another tenant, a person sees no collection, not those of their own tenant.
describe('the fake access store visibleCollections across tenants', () => {
  it('lists nothing for a tenant the person is not in and their own collections for theirs', async () => {
    const world = emptyWorld();
    world.users.push({ id: 'u', role: 'admin', suspended: false, tenantId: 'T-b' }, { id: 'old', role: 'admin', suspended: false });
    world.collections.push({ id: 'c', deleted: false, defaultPermission: null, tenantId: 'T-b' }, { id: 'legacy-c', deleted: false, defaultPermission: null });
    const store = createFakeAccessStore(world);
    expect(await store.visibleCollections('T-a', 'u')).toEqual([]);
    expect(await store.visibleCollections('T-b', 'u')).toEqual([{ collectionId: 'c', access: 'read-write' }]);
    expect(await store.visibleCollections('legacy', 'old')).toEqual([{ collectionId: 'legacy-c', access: 'read-write' }]);
  });
});
