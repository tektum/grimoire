import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAccessStore } from '../../src/permissions.js';
import { createCollections } from '../../src/collections.js';
import { addGroup, addUser, createTestDatabase } from './support.js';
import type { TestDatabase } from './support.js';

let t: TestDatabase;
let admin: string;
let member: string;
const ordering = new FakeOrdering();
const after = (last: string | null): string => ordering.between(last, null);

beforeAll(async () => {
  t = await createTestDatabase('coll');
  admin = await addUser(t.app, 'ada', 'admin');
  member = await addUser(t.app, 'max', 'member');
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL CollectionRepo', () => {
  it('appends after the last live collection and lists in position order, only the ids asked for', async () => {
    const repo = createCollections(t.app);
    const a = await repo.append({ name: 'A', createdBy: admin }, after);
    const b = await repo.append({ name: 'B', description: 'd', icon: 'i', color: 'c', defaultPermission: 'read', createdBy: admin }, after);
    expect(a.position < b.position).toBe(true);
    expect(b).toMatchObject({ name: 'B', description: 'd', icon: 'i', color: 'c', defaultPermission: 'read' });
    expect((await repo.listLive([b.id, a.id])).map((c) => c.name)).toEqual(['A', 'B']);
    expect((await repo.listLive([b.id])).map((c) => c.name)).toEqual(['B']);
    expect(await repo.listLive([])).toEqual([]);
    expect(await repo.get(a.id)).toEqual(a);
  });

  it('gives every one of many simultaneous creates its own position', async () => {
    const repo = createCollections(t.app);
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => repo.append({ name: `race${String(i)}`, createdBy: admin }, after)));
    expect(new Set(made.map((c) => c.position)).size).toBe(12);
  });

  it('does not show or change a deleted collection', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'gone', createdBy: admin }, after);
    await t.admin.query(`update collections set deleted_at = now() where id = $1`, [c.id]);
    expect(await repo.get(c.id)).toBeUndefined();
    expect(await repo.listLive([c.id])).toEqual([]);
    expect(await repo.update(c.id, { name: 'x' }, admin)).toEqual({ kind: 'not-found' });
  });

  it('changes fields and clears nullable ones; an unchanged field stays', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'edit', description: 'd', icon: 'i', createdBy: admin }, after);
    const result = await repo.update(c.id, { name: 'edited', description: null }, admin);
    expect(result).toEqual({ kind: 'updated', collection: { ...c, name: 'edited', description: null } });
  });

  it('refuses a position another live collection holds, and leaves everything as it was', async () => {
    const repo = createCollections(t.app);
    const x = await repo.append({ name: 'px', createdBy: admin }, after);
    const y = await repo.append({ name: 'py', createdBy: admin }, after);
    expect(await repo.update(y.id, { name: 'changed', position: x.position }, admin)).toEqual({ kind: 'position-taken' });
    expect(await repo.get(y.id)).toEqual(y);
  });

  it('changing defaultPermission changes what a second user\'s next call returns', async () => {
    const repo = createCollections(t.app);
    const authorizer = createAuthorizer(createAccessStore(t.app));
    const c = await repo.append({ name: 'visible', createdBy: admin }, after);
    const ask = async () => (await authorizer.checkCollection({ userId: member, collectionId: c.id })).access;
    expect(await ask()).toBe('none');
    await repo.update(c.id, { defaultPermission: 'read' }, admin);
    expect(await ask()).toBe('read-only');
    await repo.update(c.id, { defaultPermission: 'read_write' }, admin);
    expect(await ask()).toBe('read-write');
    await repo.update(c.id, { defaultPermission: null }, admin);
    expect(await ask()).toBe('none');
    expect((await authorizer.visibleCollections(member)).some((v) => v.collectionId === c.id)).toBe(false);
  });
});

describe('collection access entries', () => {
  it('upserts one entry per principal (the id stays), names it, and lists oldest first', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'acl', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Writers');
    const first = await repo.upsertAccess(c.id, { principalType: 'user', principalId: member, permission: 'read' }, admin);
    const again = await repo.upsertAccess(c.id, { principalType: 'user', principalId: member, permission: 'read_write' }, admin);
    await repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (first.kind !== 'saved' || again.kind !== 'saved') throw new Error('not saved');
    expect(again.entry).toEqual({ ...first.entry, permission: 'read_write' });
    expect(first.entry.name).toBe('max');
    const list = await repo.listAccess(c.id);
    expect(list?.entries.map((e) => [e.principalType, e.name, e.permission])).toEqual([['user', 'max', 'read_write'], ['group', 'Writers', 'read']]);
  });

  it('an entry gives access and its removal takes it away, for a user and through a group', async () => {
    const repo = createCollections(t.app);
    const authorizer = createAuthorizer(createAccessStore(t.app));
    const c = await repo.append({ name: 'acl2', createdBy: admin }, after);
    const group = await addGroup(t.app, 'Readers');
    await t.app.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [group, member]);
    const ask = async () => (await authorizer.checkCollection({ userId: member, collectionId: c.id })).access;
    expect(await ask()).toBe('none');
    const saved = await repo.upsertAccess(c.id, { principalType: 'group', principalId: group, permission: 'read' }, admin);
    if (saved.kind !== 'saved') throw new Error('not saved');
    expect(await ask()).toBe('read-only');
    expect(await repo.removeAccess(c.id, saved.entry.id, admin)).toBe(true);
    expect(await ask()).toBe('none');
    expect(await repo.removeAccess(c.id, saved.entry.id, admin)).toBe(false);
  });

  it('refuses an unknown principal, a deleted collection, and an entry of another collection', async () => {
    const repo = createCollections(t.app);
    const a = await repo.append({ name: 'acl3', createdBy: admin }, after);
    const b = await repo.append({ name: 'acl4', createdBy: admin }, after);
    const none = '00000000-0000-4000-8000-000000000000';
    expect(await repo.upsertAccess(a.id, { principalType: 'user', principalId: none, permission: 'read' }, admin)).toEqual({ kind: 'no-principal' });
    expect(await repo.upsertAccess(none, { principalType: 'user', principalId: member, permission: 'read' }, admin)).toEqual({ kind: 'not-found' });
    const saved = await repo.upsertAccess(a.id, { principalType: 'user', principalId: member, permission: 'read' }, admin);
    if (saved.kind !== 'saved') throw new Error('not saved');
    expect(await repo.removeAccess(b.id, saved.entry.id, admin)).toBe(false);
    await t.admin.query(`update collections set deleted_at = now() where id = $1`, [a.id]);
    expect(await repo.listAccess(a.id)).toBeUndefined();
    expect(await repo.upsertAccess(a.id, { principalType: 'user', principalId: member, permission: 'read_write' }, admin)).toEqual({ kind: 'not-found' });
    expect(await repo.removeAccess(a.id, saved.entry.id, admin)).toBe(false);
  });
});

const addPage = async (collectionId: string, title: string, parentId: string | null = null): Promise<string> =>
  ((await t.app.query<{ id: string }>(`insert into pages (collection_id, created_by, title, parent_id) values ($1, $2, $3, $4) returning id`, [collectionId, admin, title, parentId]))[0] as { id: string }).id;

describe('the collection tree', () => {
  it('returns only live pages, flat, with id, urlId, parentId, position, title and icon', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'tree', createdBy: admin }, after);
    const root = await addPage(c.id, 'Root');
    const child = await addPage(c.id, 'Child', root);
    const dead = await addPage(c.id, 'Dead');
    await t.admin.query(`update pages set deleted_at = now(), icon = null where id = $1`, [dead]);
    await t.admin.query(`update pages set icon = 'star' where id = $1`, [root]);
    const pages = await repo.tree(c.id);
    expect(pages?.map((p) => [p.id, p.parentId, p.title, p.icon])).toEqual([[root, null, 'Root', 'star'], [child, root, 'Child', null]]);
    expect(Object.keys(pages?.[0] ?? {}).sort()).toEqual(['icon', 'id', 'parentId', 'position', 'title', 'urlId']);
    expect(pages?.[0]?.urlId).toMatch(/\S+/);
    expect(await repo.tree('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});

describe('soft delete of a collection', () => {
  it('deletes the collection and every live page with one shared batch, removes no row, and keeps an earlier batch', async () => {
    const repo = createCollections(t.app);
    const c = await repo.append({ name: 'doomed', defaultPermission: 'read', createdBy: admin }, after);
    const keep = await repo.append({ name: 'survivor', createdBy: admin }, after);
    const a = await addPage(c.id, 'A');
    const b = await addPage(c.id, 'B', a);
    const earlier = await addPage(c.id, 'Earlier');
    const elsewhere = await addPage(keep.id, 'Elsewhere');
    const earlierBatch = ((await t.admin.query<{ id: string }>(`select gen_random_uuid() as id`))[0] as { id: string }).id;
    await t.admin.query(`update pages set deleted_at = now(), deleted_batch = $2 where id = $1`, [earlier, earlierBatch]);
    const before = Number((await t.admin.query<{ n: string }>(`select (select count(*) from pages) + (select count(*) from collections) as n`))[0]?.n);

    const result = await repo.softDelete(c.id, admin);
    expect(result?.pages).toBe(2);
    const rows = await t.admin.query<{ id: string; deleted_at: Date | null; deleted_batch: string | null; deleted_by: string | null }>(
      `select id, deleted_at, deleted_batch, deleted_by from pages where collection_id = $1 order by title`, [c.id],
    );
    expect(rows.map((r) => [r.id, r.deleted_at !== null, r.deleted_batch, r.deleted_by])).toEqual([
      [a, true, result?.batch, admin], [b, true, result?.batch, admin], [earlier, true, earlierBatch, null],
    ]);
    expect(Number((await t.admin.query<{ n: string }>(`select (select count(*) from pages) + (select count(*) from collections) as n`))[0]?.n)).toBe(before);
    expect((await t.admin.query<{ deleted_at: Date | null }>(`select deleted_at from pages where id = $1`, [elsewhere]))[0]?.deleted_at).toBeNull();

    expect(await repo.get(c.id)).toBeUndefined();
    expect(await repo.tree(c.id)).toBeUndefined();
    expect(await repo.listLive([c.id, keep.id])).toEqual([keep]);
    expect((await repo.tree(keep.id))?.map((p) => p.id)).toEqual([elsewhere]);
    expect(await repo.softDelete(c.id, admin)).toBeUndefined();
  });
});

describe('visibleCollections and checkCollection', () => {
  it('agree for every collection of the test world: live, deleted, defaults, entries, groups, roles', async () => {
    const repo = createCollections(t.app);
    const authorizer = createAuthorizer(createAccessStore(t.app));
    const viewer = await addUser(t.app, 'vera', 'viewer');
    const outsider = await addUser(t.app, 'otto', 'member');
    const group = await addGroup(t.app, 'Agreeing');
    await t.app.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [group, outsider]);
    const made = [
      await repo.append({ name: 'g-none', createdBy: admin }, after),
      await repo.append({ name: 'g-read', defaultPermission: 'read', createdBy: admin }, after),
      await repo.append({ name: 'g-rw', defaultPermission: 'read_write', createdBy: admin }, after),
      await repo.append({ name: 'g-entry', createdBy: admin }, after),
      await repo.append({ name: 'g-group', createdBy: admin }, after),
      await repo.append({ name: 'g-deleted', defaultPermission: 'read_write', createdBy: admin }, after),
    ];
    await repo.upsertAccess((made[3] as { id: string }).id, { principalType: 'user', principalId: viewer, permission: 'read_write' }, admin);
    await repo.upsertAccess((made[4] as { id: string }).id, { principalType: 'group', principalId: group, permission: 'read_write' }, admin);
    await repo.softDelete((made[5] as { id: string }).id, admin);
    const every = (await t.admin.query<{ id: string }>(`select id from collections`)).map((r) => r.id);
    for (const user of [admin, member, viewer, outsider]) {
      const visible = new Map((await authorizer.visibleCollections(user)).map((v) => [v.collectionId, v.access]));
      for (const id of every) {
        const decided = await authorizer.checkCollection({ userId: user, collectionId: id });
        expect([id, visible.get(id) ?? 'none']).toEqual([id, decided.access]);
      }
    }
    expect((await authorizer.visibleCollections(viewer)).find((v) => v.collectionId === (made[3] as { id: string }).id)?.access).toBe('read-only');
  });
});
