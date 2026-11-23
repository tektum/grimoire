import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAudit } from '../../src/audit.js';
import { createCollections } from '../../src/collections.js';
import { addGroup, addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let admin: string;
const ordering = new FakeOrdering();
const after = (last: string | null): string => ordering.between(last, null);
const events = (target: string) =>
  t.admin.query<{ action: string; target_type: string; target_id: string; actor_id: string }>(
    `select action, target_type, target_id, actor_id from audit_events where target_id = $1 order by id`, [target],
  );

beforeAll(async () => {
  t = await createTestDatabase('audit');
  admin = await addUser(t.app, 'ada', 'admin');
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL AuditLog', () => {
  it('appends a row with its detail, and nothing else about it can be read back by this port', async () => {
    const target = 'target-1';
    await createAudit(t.app).append({ actorId: admin, action: 'thing.done', targetType: 'thing', targetId: target, detail: { n: 1 } });
    await createAudit(t.app).append({ actorId: null, action: 'thing.done_by_nobody', targetType: 'thing', targetId: target });
    const rows = await t.admin.query<{ actor_id: string | null; detail: unknown }>(`select actor_id, detail from audit_events where target_id = $1 order by id`, [target]);
    expect(rows).toEqual([{ actor_id: admin, detail: { n: 1 } }, { actor_id: null, detail: null }]);
  });

  it('the runtime role cannot update or delete an audit row', async () => {
    await createAudit(t.app).append({ actorId: admin, action: 'thing.kept', targetType: 'thing', targetId: 'target-2' });
    await expect(t.app.query(`update audit_events set action = 'x' where target_id = 'target-2'`)).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`delete from audit_events where target_id = 'target-2'`)).rejects.toMatchObject({ code: '42501' });
    expect(await events('target-2')).toHaveLength(1);
  });
});

describe('the audit row of a collection change', () => {
  it('a default-permission change writes exactly one row, and a change of other fields writes none', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'audited', createdBy: admin }, after);
    await repo.update(c.id, { name: 'renamed' }, admin);
    expect(await events(c.id)).toEqual([]);
    await repo.update(c.id, { defaultPermission: 'read' }, admin);
    expect(await events(c.id)).toEqual([{ action: 'collection.default_permission_changed', target_type: 'collection', target_id: c.id, actor_id: admin }]);
    await repo.update(c.id, { defaultPermission: 'read' }, admin);
    expect(await events(c.id)).toHaveLength(1);
  });

  it('creating with a default permission writes one row, and without one none', async () => {
    const repo = createCollections(t.app);
    const plain = await repo.append({ name: 'plain', createdBy: admin }, after);
    const shared = await repo.append({ name: 'shared', defaultPermission: 'read', createdBy: admin }, after);
    expect(await events(plain.id)).toEqual([]);
    expect(await events(shared.id)).toEqual([{ action: 'collection.default_permission_changed', target_type: 'collection', target_id: shared.id, actor_id: admin }]);
  });

  it('an access upsert and an access removal each write exactly one row', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'acl-audit', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Audited');
    const saved = await repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (saved.kind !== 'saved') throw new Error('not saved');
    expect(await events(c.id)).toEqual([{ action: 'collection.access_upserted', target_type: 'collection', target_id: c.id, actor_id: admin }]);
    await repo.removeAccess(c.id, saved.entry.id, admin);
    expect((await events(c.id)).map((e) => e.action)).toEqual(['collection.access_upserted', 'collection.access_removed']);
    expect(await repo.removeAccess(c.id, saved.entry.id, admin)).toBe(false);
    expect(await events(c.id)).toHaveLength(2);
    const again = await repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: 'read_write' }, admin);
    const changed = await repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (again.kind !== 'saved' || changed.kind !== 'saved') throw new Error('not saved');
    const details = await t.admin.query<{ detail: unknown }>(`select detail from audit_events where target_id = $1 and action = 'collection.access_upserted' order by id`, [c.id]);
    expect(details.map((d) => d.detail)).toEqual([
      { principalType: 'group', principalId: group, permission: 'read', entryId: saved.entry.id, previousPermission: null },
      { principalType: 'group', principalId: group, permission: 'read_write', entryId: again.entry.id, previousPermission: null },
      { principalType: 'group', principalId: group, permission: 'read', entryId: again.entry.id, previousPermission: 'read_write' },
    ]);
  });

  it('simultaneous first grants to one principal record a previous permission of null only once', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'acl-race', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Racers');
    await Promise.all(['read', 'read_write', 'read', 'read_write'].map((permission) =>
      repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: permission as 'read' }, admin)));
    const rows = await t.admin.query<{ detail: { previousPermission: string | null } }>(`select detail from audit_events where target_id = $1 order by id`, [c.id]);
    expect(rows.map((r) => r.detail.previousPermission).filter((p) => p === null)).toHaveLength(1);
    expect(rows).toHaveLength(4);
  });

  it('a failed upsert leaves no audit row', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'acl-fail', createdBy: admin }, after);
    expect(await repo.upsertAccess(c.id, { principalType: 'user', principalId: '00000000-0000-4000-8000-000000000000', permission: 'read' }, admin)).toEqual({ kind: 'no-principal' });
    expect(await events(c.id)).toEqual([]);
  });

  it('a change that fails leaves no audit row and no change: both are one transaction', async () => {
    const repo = createCollections(t.app);
    const x = await repo.append({ name: 'tx1', createdBy: admin }, after);
    const y = await repo.append({ name: 'tx2', createdBy: admin }, after);
    expect(await repo.update(y.id, { defaultPermission: 'read_write', position: x.position }, admin)).toEqual({ kind: 'position-taken' });
    expect(await events(y.id)).toEqual([]);
    expect((await repo.get(y.id))?.defaultPermission).toBeNull();
  });
});
