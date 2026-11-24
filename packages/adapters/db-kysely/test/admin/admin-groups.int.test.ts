import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAdmin } from '../../src/admin.js';
import { createCollections } from '../../src/collections.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let boss: string;
beforeAll(async () => {
  t = await createTestDatabase('admingroups');
  boss = await addUser(t.app, 'boss', 'admin');
}, 60_000);
afterAll(async () => { await t?.drop(); });

const events = (action: string) =>
  t.admin.query<{ actor_id: string; target_id: string; detail: Record<string, unknown> | null }>(`select actor_id, target_id, detail from audit_events where action = $1`, [action]);
const saved = (r: { kind: string; group?: { id: string } }): string => {
  expect(r.kind).toBe('saved');
  return (r.group as { id: string }).id;
};

describe('the PostgreSQL AdminRepo: groups', () => {
  it('refuses a name that differs only in case, on create and on rename, and writes no audit row for the refusal', async () => {
    const repo = createAdmin(t.app);
    const design = saved(await repo.createGroup('legacy', 'Design', boss));
    expect(await repo.createGroup('legacy', 'DESIGN', boss)).toEqual({ kind: 'name-taken' });
    const ops = saved(await repo.createGroup('legacy', 'Ops', boss));
    expect(await repo.renameGroup('legacy', ops, 'design', boss)).toEqual({ kind: 'name-taken' });
    expect(await repo.renameGroup('legacy', design, 'design', boss)).toMatchObject({ kind: 'saved', group: { name: 'design' } });
    expect(await repo.renameGroup('legacy', '00000000-0000-4000-8000-000000000000', 'zzz', boss)).toEqual({ kind: 'not-found' });
    expect((await events('group.created')).map((r) => r.target_id)).toEqual([design, ops]);
    expect(await events('group.renamed')).toHaveLength(1);
  });

  it('adds a member once, lists members with counts, removes, and writes one audit row per real change with ids only', async () => {
    const repo = createAdmin(t.app);
    const group = saved(await repo.createGroup('legacy', 'Team', boss));
    const amy = await addUser(t.app, 'amy');
    const bo = await addUser(t.app, 'bo');
    expect(await repo.addMember('legacy', group, bo, boss)).toBe('added');
    expect(await repo.addMember('legacy', group, amy, boss)).toBe('added');
    expect(await repo.addMember('legacy', group, amy, boss)).toBe('already-member');
    expect(await repo.addMember('legacy', group, '00000000-0000-4000-8000-000000000000', boss)).toBe('no-user');
    expect(await repo.addMember('legacy', '00000000-0000-4000-8000-000000000000', amy, boss)).toBe('no-group');
    expect((await repo.listMembers('legacy', group))?.map((u) => u.name)).toEqual(['amy', 'bo']);
    expect((await repo.listGroups('legacy')).find((g) => g.id === group)?.memberCount).toBe(2);
    expect(await repo.listMembers('legacy', '00000000-0000-4000-8000-000000000000')).toBeUndefined();
    expect(await repo.removeMember('legacy', group, amy, boss)).toBe(true);
    expect(await repo.removeMember('legacy', group, amy, boss)).toBe(false);
    const added = (await events('group.member_added')).filter((r) => r.target_id === group);
    expect(added.map((r) => r.detail)).toEqual([{ userId: bo }, { userId: amy }]);
    expect((await events('group.member_removed')).filter((r) => r.target_id === group)).toHaveLength(1);
    expect(JSON.stringify(await events('group.member_added'))).not.toContain('@');
  });

  it('deleting a group removes its members and its collection access entries, and no other group is touched', async () => {
    const repo = createAdmin(t.app);
    const collections = createCollections(t.app);
    const ordering = new FakeOrdering();
    const collection = await collections.append('legacy', { name: 'Docs', createdBy: boss }, (last) => ordering.between(last, null));
    const gone = saved(await repo.createGroup('legacy', 'Gone', boss));
    const kept = saved(await repo.createGroup('legacy', 'Kept', boss));
    const user = await addUser(t.app, 'cy');
    for (const g of [gone, kept]) {
      await repo.addMember('legacy', g, user, boss);
      await collections.upsertAccess('legacy', collection.id, { principalType: 'group', principalId: g, permission: 'read' }, boss);
    }
    expect(await repo.deleteGroup('legacy', gone, boss)).toBe(true);
    expect(await repo.deleteGroup('legacy', gone, boss)).toBe(false);
    expect(await t.admin.query(`select 1 from group_members where group_id = $1`, [gone])).toEqual([]);
    expect(await t.admin.query(`select 1 from collection_access where group_id = $1`, [gone])).toEqual([]);
    expect(await t.admin.query(`select 1 from group_members where group_id = $1`, [kept])).toHaveLength(1);
    expect(await t.admin.query(`select 1 from collection_access where group_id = $1`, [kept])).toHaveLength(1);
    expect((await events('group.deleted')).map((r) => r.target_id)).toEqual([gone]);
  });
});
