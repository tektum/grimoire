import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAudit } from '../../src/audit.js';
import { createCollections } from '../../src/collections.js';
import { addGroup, addTenant, addUser, createTestDatabase } from '../collections/support.js';
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

  it('records the tenant of the actor when the event names none, the named one when it does, and legacy for the system', async () => {
    await addTenant(t.app, 'T-audit');
    const actor = await addUser(t.app, 'audited', 'member', 'T-audit');
    const audit = createAudit(t.app);
    await audit.append({ actorId: actor, action: 'thing.unnamed', targetType: 'thing', targetId: 'target-3' });
    await audit.append({ actorId: actor, action: 'thing.named', targetType: 'thing', targetId: 'target-3', tenantId: 'legacy' });
    await audit.append({ actorId: null, action: 'thing.system', targetType: 'thing', targetId: 'target-3' });
    const rows = await t.admin.query<{ action: string; tenant_id: string }>(`select action, tenant_id from audit_events where target_id = 'target-3' order by id`);
    expect(rows).toEqual([
      { action: 'thing.unnamed', tenant_id: 'T-audit' },
      { action: 'thing.named', tenant_id: 'legacy' },
      { action: 'thing.system', tenant_id: 'legacy' },
    ]);
  });
});

describe('the audit row of a collection change', () => {
  it('a default-permission change writes exactly one row, and a change of other fields writes none', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append('legacy', { name: 'audited', createdBy: admin }, after);
    await repo.update('legacy', c.id, { name: 'renamed' }, admin);
    expect(await events(c.id)).toEqual([]);
    await repo.update('legacy', c.id, { defaultPermission: 'read' }, admin);
    expect(await events(c.id)).toEqual([{ action: 'collection.default_permission_changed', target_type: 'collection', target_id: c.id, actor_id: admin }]);
    await repo.update('legacy', c.id, { defaultPermission: 'read' }, admin);
    expect(await events(c.id)).toHaveLength(1);
  });

  it('creating with a default permission writes one row, and without one none', async () => {
    const repo = createCollections(t.app);
    const plain = await repo.append('legacy', { name: 'plain', createdBy: admin }, after);
    const shared = await repo.append('legacy', { name: 'shared', defaultPermission: 'read', createdBy: admin }, after);
    expect(await events(plain.id)).toEqual([]);
    expect(await events(shared.id)).toEqual([{ action: 'collection.default_permission_changed', target_type: 'collection', target_id: shared.id, actor_id: admin }]);
  });

  it('an access upsert and an access removal each write exactly one row', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append('legacy', { name: 'acl-audit', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Audited');
    const saved = await repo.upsertAccess('legacy', c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (saved.kind !== 'saved') throw new Error('not saved');
    expect(await events(c.id)).toEqual([{ action: 'collection.access_upserted', target_type: 'collection', target_id: c.id, actor_id: admin }]);
    await repo.removeAccess('legacy', c.id, saved.entry.id, admin);
    expect((await events(c.id)).map((e) => e.action)).toEqual(['collection.access_upserted', 'collection.access_removed']);
    expect(await repo.removeAccess('legacy', c.id, saved.entry.id, admin)).toBe(false);
    expect(await events(c.id)).toHaveLength(2);
    const again = await repo.upsertAccess('legacy', c.id, { principalType: 'group', principalId: group, permission: 'read_write' }, admin);
    const changed = await repo.upsertAccess('legacy', c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (again.kind !== 'saved' || changed.kind !== 'saved') throw new Error('not saved');
    const details = await t.admin.query<{ detail: unknown }>(`select detail from audit_events where target_id = $1 and action = 'collection.access_upserted' order by id`, [c.id]);
    expect(details.map((d) => d.detail)).toEqual([
      { principalType: 'group', principalId: group, permission: 'read', entryId: saved.entry.id, previousPermission: null },
      { principalType: 'group', principalId: group, permission: 'read_write', entryId: again.entry.id, previousPermission: null },
      { principalType: 'group', principalId: group, permission: 'read', entryId: again.entry.id, previousPermission: 'read_write' },
    ]);
  });

  it('first grants to one principal wait for each other on the collection, so only the first records a previous permission of null', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append('legacy', { name: 'acl-race', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Racers');
    // Another transaction holds the collection; the grants are started while it does, and must queue behind it (a lock that is missing fails the wait).
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = t.app.transaction(async (tx) => {
      await tx.query(`select 1 from collections where id = $1 for update`, [c.id]);
      held();
      await gate;
    });
    await locked;
    const grants = Promise.all(['read', 'read_write', 'read', 'read_write'].map((permission) =>
      repo.upsertAccess('legacy', c.id, { principalType: 'group', principalId: group, permission: permission as 'read' }, admin)));
    await vi.waitFor(async () => {
      const waiting = await t.app.query<{ n: string }>(`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      expect(Number(waiting[0]?.n)).toBe(4);
    });
    release();
    await Promise.all([holder, grants]);
    const rows = await t.admin.query<{ detail: { previousPermission: string | null } }>(`select detail from audit_events where target_id = $1 order by id`, [c.id]);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.detail.previousPermission).filter((p) => p === null)).toHaveLength(1);
  });

  it('deleting a collection writes one row naming the batch', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append('legacy', { name: 'del-audit', createdBy: admin }, after);
    const result = await repo.softDelete('legacy', c.id, admin);
    expect(await events(c.id)).toEqual([{ action: 'collection.deleted', target_type: 'collection', target_id: c.id, actor_id: admin }]);
    const detail = (await t.admin.query<{ detail: unknown }>(`select detail from audit_events where target_id = $1`, [c.id]))[0]?.detail;
    expect(detail).toEqual({ batch: result?.batch, pages: 0 });
    expect(await repo.softDelete('legacy', c.id, admin)).toBeUndefined();
    expect(await events(c.id)).toHaveLength(1);
  });

  it('a failed upsert leaves no audit row', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append('legacy', { name: 'acl-fail', createdBy: admin }, after);
    expect(await repo.upsertAccess('legacy', c.id, { principalType: 'user', principalId: '00000000-0000-4000-8000-000000000000', permission: 'read' }, admin)).toEqual({ kind: 'no-principal' });
    expect(await events(c.id)).toEqual([]);
  });

  it('a change that fails leaves no audit row and no change: both are one transaction', async () => {
    const repo = createCollections(t.app);
    const x = await repo.append('legacy', { name: 'tx1', createdBy: admin }, after);
    const y = await repo.append('legacy', { name: 'tx2', createdBy: admin }, after);
    expect(await repo.update('legacy', y.id, { defaultPermission: 'read_write', position: x.position }, admin)).toEqual({ kind: 'position-taken' });
    expect(await events(y.id)).toEqual([]);
    expect((await repo.get('legacy', y.id))?.defaultPermission).toBeNull();
  });
});
