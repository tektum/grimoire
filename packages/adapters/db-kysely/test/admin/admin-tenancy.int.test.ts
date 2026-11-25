import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin } from '../../src/admin.js';
import { addTenant, addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// Section 7, surface 6 of docs/tenancy.md (people and groups): a person of one tenant never sees, changes or reaches a user or a group of another, and the rule "the last
// administrator" is the last of their own tenant. Two tenants, each with an administrator and a member, and `legacy` alongside.
const NOBODY = '00000000-0000-4000-8000-000000000000';
let t: TestDatabase;
let a: { boss: string; amy: string };
let b: { boss: string; bea: string };
beforeAll(async () => {
  t = await createTestDatabase('admintenancy');
  await addTenant(t.admin, 'T-a');
  await addTenant(t.admin, 'T-b');
  a = { boss: await addUser(t.app, 'boss-a', 'admin', 'T-a'), amy: await addUser(t.app, 'amy-a', 'member', 'T-a') };
  b = { boss: await addUser(t.app, 'boss-b', 'admin', 'T-b'), bea: await addUser(t.app, 'bea-b', 'member', 'T-b') };
}, 60_000);
afterAll(async () => { await t?.drop(); });

const groupId = (r: { kind: string; group?: { id: string } }): string => {
  expect(r.kind).toBe('saved');
  return (r.group as { id: string }).id;
};

describe('the PostgreSQL AdminRepo across tenants', () => {
  it('writes every audit row of a change under the tenant it happened in', async () => {
    const repo = createAdmin(t.app);
    const group = groupId(await repo.createGroup('T-b', 'Audited', b.boss));
    await repo.renameGroup('T-b', group, 'Audited too', b.boss);
    await repo.addMember('T-b', group, b.bea, b.boss);
    await repo.removeMember('T-b', group, b.bea, b.boss);
    await repo.patchUser('T-b', b.bea, { role: 'viewer' }, b.boss);
    await repo.patchUser('T-b', b.bea, { suspended: true }, b.boss);
    await repo.deleteGroup('T-b', group, b.boss);
    const rows = await t.admin.query<{ action: string; tenant_id: string }>(`select action, tenant_id from audit_events where actor_id = '${b.boss}' order by action`);
    expect(rows.map((r) => r.action)).toEqual(['group.created', 'group.deleted', 'group.member_added', 'group.member_removed', 'group.renamed', 'user.role_changed', 'user.suspended']);
    expect([...new Set(rows.map((r) => r.tenant_id))]).toEqual(['T-b']);
  });

  it('lists only the users of the tenant asked for, and resolves names only inside it', async () => {
    const repo = createAdmin(t.app);
    expect((await repo.listUsers('T-a', { limit: 10 })).map((u) => u.name)).toEqual(['amy-a', 'boss-a']);
    expect((await repo.listUsers('T-b', { limit: 10, q: 'b' })).map((u) => u.name)).toEqual(['bea-b', 'boss-b']);
    expect((await repo.listUsers('T-a', { limit: 10, q: 'bea' }))).toEqual([]);
    expect((await repo.userNames('T-a', [a.amy, b.bea])).map((u) => u.id)).toEqual([a.amy]);
  });

  it('allows the same group name in two tenants, lists each tenant its own, and refuses a name taken inside one', async () => {
    const repo = createAdmin(t.app);
    const inA = groupId(await repo.createGroup('T-a', 'Design', a.boss));
    const inB = groupId(await repo.createGroup('T-b', 'Design', b.boss));
    expect(await repo.createGroup('T-a', 'DESIGN', a.boss)).toEqual({ kind: 'name-taken' });
    expect((await repo.listGroups('T-a')).map((g) => g.id)).toEqual([inA]);
    expect((await repo.listGroups('T-b')).map((g) => g.id)).toEqual([inB]);
    expect(await t.admin.query(`select tenant_id from groups where id = '${inA}'`)).toEqual([{ tenant_id: 'T-a' }]);
  });

  it('treats a group of another tenant as absent: rename, delete, list and add and remove members', async () => {
    const repo = createAdmin(t.app);
    const mine = groupId(await repo.createGroup('T-a', 'Ops', a.boss));
    expect(await repo.renameGroup('T-b', mine, 'Stolen', b.boss)).toEqual({ kind: 'not-found' });
    expect(await repo.listMembers('T-b', mine)).toBeUndefined();
    expect(await repo.addMember('T-b', mine, b.bea, b.boss)).toBe('no-group');
    expect(await repo.deleteGroup('T-b', mine, b.boss)).toBe(false);
    expect(await repo.addMember('T-a', mine, a.amy, a.boss)).toBe('added');
    expect(await repo.removeMember('T-b', mine, a.amy, b.boss)).toBe(false);
    expect((await repo.listMembers('T-a', mine))?.map((u) => u.name)).toEqual(['amy-a']);
    expect((await repo.listGroups('T-a')).find((g) => g.id === mine)).toMatchObject({ name: 'Ops', memberCount: 1 });
  });

  it('does not add a person of another tenant to a group', async () => {
    const repo = createAdmin(t.app);
    const mine = groupId(await repo.createGroup('T-a', 'Writers', a.boss));
    expect(await repo.addMember('T-a', mine, b.bea, a.boss)).toBe('no-user');
    expect(await t.admin.query(`select 1 from group_members where group_id = '${mine}'`)).toEqual([]);
  });

  it('changes only a person of its own tenant, and the last administrator is the last of that tenant', async () => {
    const repo = createAdmin(t.app);
    expect(await repo.patchUser('T-a', b.bea, { role: 'viewer' }, a.boss)).toEqual({ kind: 'not-found' });
    expect(await repo.patchUser('T-a', a.boss, { role: 'member' }, a.boss)).toEqual({ kind: 'last-admin' });
    expect(await repo.patchUser('T-a', a.boss, { suspended: true }, a.boss)).toEqual({ kind: 'last-admin' });
    expect(await repo.patchUser('T-b', b.bea, { role: 'viewer' }, b.boss)).toMatchObject({ kind: 'saved', user: { role: 'viewer' } });
    expect(await t.admin.query(`select role from users where id = '${a.amy}'`)).toEqual([{ role: 'member' }]);
  });

  it('keeps the unknown id answers of before', async () => {
    const repo = createAdmin(t.app);
    expect(await repo.renameGroup('T-a', NOBODY, 'x', a.boss)).toEqual({ kind: 'not-found' });
    expect(await repo.patchUser('T-a', NOBODY, { role: 'viewer' }, a.boss)).toEqual({ kind: 'not-found' });
  });
});
