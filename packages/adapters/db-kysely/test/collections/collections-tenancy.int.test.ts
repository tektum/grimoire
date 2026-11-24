import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { addGroup, addTenant, addUser, createTestDatabase } from './support.js';
import type { TestDatabase } from './support.js';

// docs/tenancy.md section 7, surface 1 (collections): a collection, its access entries and its tree belong to one tenant; another tenant sees them as absent and cannot grant them to
// its own people or groups, and cannot be handed theirs. Positions are per tenant.
const ordering = new FakeOrdering();
const after = (last: string | null): string => ordering.between(last, null);
let t: TestDatabase;
let a: { boss: string; amy: string; group: string };
let b: { boss: string; bea: string; group: string };
beforeAll(async () => {
  t = await createTestDatabase('colltenancy');
  await addTenant(t.app, 'T-a');
  await addTenant(t.app, 'T-b');
  a = { boss: await addUser(t.app, 'boss-a', 'admin', 'T-a'), amy: await addUser(t.app, 'amy-a', 'member', 'T-a'), group: await addGroup(t.app, 'Writers', 'T-a') };
  b = { boss: await addUser(t.app, 'boss-b', 'admin', 'T-b'), bea: await addUser(t.app, 'bea-b', 'member', 'T-b'), group: await addGroup(t.app, 'Writers', 'T-b') };
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL CollectionRepo across tenants', () => {
  it('writes every audit row of a collection change under the tenant it happened in', async () => {
    const repo = createCollections(t.app);
    const made = await repo.append('T-b', { name: 'Audited', defaultPermission: 'read', createdBy: b.boss }, after);
    await repo.update('T-b', made.id, { defaultPermission: 'read_write' }, b.boss);
    const granted = await repo.upsertAccess('T-b', made.id, { principalType: 'user', principalId: b.bea, permission: 'read' }, b.boss);
    await repo.removeAccess('T-b', made.id, granted.kind === 'saved' ? granted.entry.id : '', b.boss);
    await repo.softDelete('T-b', made.id, b.boss);
    const rows = await t.admin.query<{ action: string; tenant_id: string }>(`select action, tenant_id from audit_events where target_id = '${made.id}' order by action`);
    expect(rows.map((r) => r.action)).toEqual(['collection.access_removed', 'collection.access_upserted', 'collection.default_permission_changed', 'collection.default_permission_changed', 'collection.deleted']);
    expect([...new Set(rows.map((r) => r.tenant_id))]).toEqual(['T-b']);
  });

  it('creates a collection in the tenant, with the same first position free in the other, and lists, reads and changes only its own', async () => {
    const repo = createCollections(t.app);
    const inA = await repo.append('T-a', { name: 'Docs', createdBy: a.boss }, after);
    const inB = await repo.append('T-b', { name: 'Docs', createdBy: b.boss }, after);
    expect(inA.position).toBe(inB.position);
    expect(await t.admin.query(`select tenant_id from collections where id = '${inA.id}'`)).toEqual([{ tenant_id: 'T-a' }]);
    expect((await repo.listLive('T-a', [inA.id, inB.id])).map((c) => c.id)).toEqual([inA.id]);
    expect(await repo.get('T-b', inA.id)).toBeUndefined();
    expect(await repo.update('T-b', inA.id, { name: 'Stolen' }, b.boss)).toEqual({ kind: 'not-found' });
    expect(await repo.update('T-a', inA.id, { name: 'Handbook' }, a.boss)).toMatchObject({ kind: 'updated', collection: { name: 'Handbook' } });
    expect(await repo.get('T-b', inB.id)).toMatchObject({ name: 'Docs' });
  });

  it('refuses a position taken inside one tenant only', async () => {
    const repo = createCollections(t.app);
    const first = await repo.append('T-a', { name: 'P1', createdBy: a.boss }, after);
    const second = await repo.append('T-a', { name: 'P2', createdBy: a.boss }, after);
    expect(await repo.update('T-a', second.id, { position: first.position }, a.boss)).toEqual({ kind: 'position-taken' });
    const otherTenant = await repo.append('T-b', { name: 'P3', createdBy: b.boss }, () => first.position);
    expect(otherTenant.position).toBe(first.position);
  });

  it('treats the access entries, the tree and the deletion of another tenant\'s collection as absent', async () => {
    const repo = createCollections(t.app);
    const mine = await repo.append('T-a', { name: 'Private', createdBy: a.boss }, after);
    const granted = await repo.upsertAccess('T-a', mine.id, { principalType: 'user', principalId: a.amy, permission: 'read' }, a.boss);
    expect(granted).toMatchObject({ kind: 'saved' });
    const entry = granted.kind === 'saved' ? granted.entry.id : '';
    expect(await t.admin.query(`select tenant_id from collection_access where id = '${entry}'`)).toEqual([{ tenant_id: 'T-a' }]);
    expect(await repo.listAccess('T-b', mine.id)).toBeUndefined();
    expect(await repo.upsertAccess('T-b', mine.id, { principalType: 'user', principalId: b.bea, permission: 'read_write' }, b.boss)).toEqual({ kind: 'not-found' });
    expect(await repo.removeAccess('T-b', mine.id, entry, b.boss)).toBe(false);
    expect(await repo.tree('T-b', mine.id)).toBeUndefined();
    expect(await repo.softDelete('T-b', mine.id, b.boss)).toBeUndefined();
    expect(await repo.get('T-a', mine.id)).toMatchObject({ name: 'Private' });
    expect((await repo.listAccess('T-a', mine.id))?.entries).toHaveLength(1);
  });

  it('refuses to grant to a person or a group of another tenant, and writes nothing', async () => {
    const repo = createCollections(t.app);
    const mine = await repo.append('T-a', { name: 'Shared', createdBy: a.boss }, after);
    expect(await repo.upsertAccess('T-a', mine.id, { principalType: 'user', principalId: b.bea, permission: 'read' }, a.boss)).toEqual({ kind: 'no-principal' });
    expect(await repo.upsertAccess('T-a', mine.id, { principalType: 'group', principalId: b.group, permission: 'read' }, a.boss)).toEqual({ kind: 'no-principal' });
    expect(await repo.upsertAccess('T-a', mine.id, { principalType: 'group', principalId: a.group, permission: 'read' }, a.boss)).toMatchObject({ kind: 'saved' });
    expect((await repo.listAccess('T-a', mine.id))?.entries).toHaveLength(1);
  });
});
