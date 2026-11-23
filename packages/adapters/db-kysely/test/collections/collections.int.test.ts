import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAccessStore } from '../../src/permissions.js';
import { createCollections } from '../../src/collections.js';
import { addUser, createTestDatabase } from './support.js';
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
