import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin } from '../../src/admin.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase('adminusers'); }, 60_000);
afterAll(async () => { await t?.drop(); });

const events = async (action: string) =>
  t.admin.query<{ actor_id: string; target_id: string; detail: Record<string, unknown> | null }>(`select actor_id, target_id, detail from audit_events where action = $1`, [action]);
const reset = async () => { await t.admin.query(`delete from audit_events`); await t.admin.query(`delete from users`); };

describe('the PostgreSQL AdminRepo: users', () => {
  it('lists in email order by keyset and filters by a part of the name or the email, ignoring case and wildcards', async () => {
    await reset();
    const ids = [await addUser(t.app, 'Bea'), await addUser(t.app, 'ann'), await addUser(t.app, 'cy_x')];
    const repo = createAdmin(t.app);
    const page = await repo.listUsers({ limit: 2 });
    expect(page.map((u) => u.name)).toEqual(['ann', 'Bea']);
    const next = await repo.listUsers({ limit: 2, after: [page[1]?.email as string, page[1]?.id as string] });
    expect(next.map((u) => u.id)).toEqual([ids[2]]);
    expect((await repo.listUsers({ limit: 10, q: 'BEA' })).map((u) => u.name)).toEqual(['Bea']);
    expect((await repo.listUsers({ limit: 10, q: '_' })).map((u) => u.name)).toEqual(['cy_x']);
    expect(await repo.listUsers({ limit: 10, q: '%' })).toEqual([]);
  });

  it('answers names for known ids only', async () => {
    await reset();
    const one = await addUser(t.app, 'one');
    const names = await createAdmin(t.app).userNames([one, '00000000-0000-4000-8000-000000000000']);
    expect(names).toEqual([{ id: one, name: 'one' }]);
  });

  it('refuses to demote or suspend the last active administrator, and writes nothing', async () => {
    await reset();
    const only = await addUser(t.app, 'only', 'admin');
    await addUser(t.app, 'other', 'member');
    const repo = createAdmin(t.app);
    expect(await repo.patchUser(only, { role: 'member' }, only)).toEqual({ kind: 'last-admin' });
    expect(await repo.patchUser(only, { suspended: true }, only)).toEqual({ kind: 'last-admin' });
    expect(await t.admin.query(`select 1 from users where id = $1 and role = 'admin' and suspended_at is null`, [only])).toHaveLength(1);
    expect(await events('user.role_changed')).toEqual([]);
  });

  it('leaves one administrator when two demote each other at the same time', async () => {
    await reset();
    const a = await addUser(t.app, 'a1', 'admin');
    const b = await addUser(t.app, 'a2', 'admin');
    const repo = createAdmin(t.app);
    const results = await Promise.all([repo.patchUser(a, { role: 'member' }, b), repo.patchUser(b, { role: 'member' }, a)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['last-admin', 'saved']);
    expect(await t.admin.query(`select 1 from users where role = 'admin' and suspended_at is null`)).toHaveLength(1);
  });

  it('suspends and unsuspends the same row, with one audit row each and no email or name in it', async () => {
    await reset();
    const boss = await addUser(t.app, 'boss', 'admin');
    const user = await addUser(t.app, 'mia');
    const repo = createAdmin(t.app);
    const suspended = await repo.patchUser(user, { suspended: true }, boss);
    expect(suspended).toMatchObject({ kind: 'saved', user: { id: user, suspended: true } });
    expect(await t.admin.query(`select 1 from users where id = $1 and suspended_at is not null`, [user])).toHaveLength(1);
    expect(await repo.patchUser(user, { suspended: false }, boss)).toMatchObject({ kind: 'saved', user: { id: user, suspended: false } });
    expect(await repo.patchUser(user, { suspended: false }, boss)).toMatchObject({ kind: 'saved' });
    const rows = [...(await events('user.suspended')), ...(await events('user.unsuspended'))];
    expect(rows.map((r) => [r.actor_id, r.target_id])).toEqual([[boss, user], [boss, user]]);
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('records a role change with the old and the new role, and an unknown user is not found', async () => {
    await reset();
    const boss = await addUser(t.app, 'boss', 'admin');
    const user = await addUser(t.app, 'lee');
    const repo = createAdmin(t.app);
    expect(await repo.patchUser(user, { role: 'viewer' }, boss)).toMatchObject({ kind: 'saved', user: { role: 'viewer' } });
    expect((await events('user.role_changed')).map((r) => r.detail)).toEqual([{ from: 'member', to: 'viewer' }]);
    expect(await repo.patchUser('00000000-0000-4000-8000-000000000000', { role: 'viewer' }, boss)).toEqual({ kind: 'not-found' });
  });
});
