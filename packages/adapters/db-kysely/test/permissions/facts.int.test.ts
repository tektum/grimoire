import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { accessCases, collectionExpectOf, worldOfCases } from '@tektum/grimoire-core/testing/access-cases';
import type { Expected } from '@tektum/grimoire-core/testing/access-cases';
import { createFakeAccessStore } from '@tektum/grimoire-core/testing/fake-access-store';
import type { AccessDecision, CollectionDecision } from '@tektum/grimoire-core/authorize/decide';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { counting, createMigratedDatabase, dropDatabase, loadWorld, urlFor } from './support.js';
import { appUrl } from '@tektum/grimoire-test-support/database';

const DB = `grimoire_m3t04_facts_${String(process.pid)}`;
const { world, ids } = worldOfCases();
const label = (d: AccessDecision | CollectionDecision): Expected => (d.access === 'none' ? d.reason : d.access);
let db: KyselyDatabase;

beforeAll(async () => {
  await createMigratedDatabase(DB);
  await loadWorld(DB, world);
  db = createDatabase(urlFor('grimoire_app', DB));
}, 180_000);
afterAll(async () => {
  await db.close();
  await dropDatabase(DB);
});

describe('the shared table through createAccessStore and createAuthorizer (PostgreSQL)', () => {
  accessCases.forEach((c, i) => {
    it(c.name, async () => {
      const id = ids[i];
      if (!id) throw new Error('row without ids');
      const authorizer = createAuthorizer(createAccessStore(db));
      const d = await authorizer.check({ userId: id.userId, pageId: id.pageId }, { includeDeleted: c.includeDeleted });
      expect(label(d)).toBe(c.expect);
      if (d.access !== 'none') expect(d.epoch).toBe(i + 1);
      const want = collectionExpectOf(c);
      if (want !== 'skip') {
        const k = await authorizer.checkCollection({ userId: id.userId, collectionId: id.collectionId }, { includeDeleted: c.includeDeleted });
        expect(label(k)).toBe(want);
      }
    });
  });

  it('gives the same decisions as the fake store for every row, with and without includeDeleted', async () => {
    const sql = createAuthorizer(createAccessStore(db));
    const fake = createAuthorizer(createFakeAccessStore(world));
    const requests = ids.map((id) => ({ userId: id.userId, pageId: id.pageId }));
    expect(await sql.checkMany(requests)).toEqual(await fake.checkMany(requests));
    for (const includeDeleted of [false, true]) {
      for (const id of ids) {
        expect(await sql.check({ userId: id.userId, pageId: id.pageId }, { includeDeleted })).toEqual(await fake.check({ userId: id.userId, pageId: id.pageId }, { includeDeleted }));
      }
    }
  });

  it('visibleCollections agrees with checkCollection for every user and collection of the world', async () => {
    const a = createAuthorizer(createAccessStore(db));
    // One user at a time, that user's collections checked at once (the pool is shared): the same comparisons, in far fewer sequential round trips.
    for (const includeDeleted of [false, true]) {
      for (const u of world.users) {
        const listed = new Map((await a.visibleCollections(u.id, { includeDeleted })).map((r) => [r.collectionId, r.access]));
        const decided = await Promise.all(world.collections.map((c) => a.checkCollection({ userId: u.id, collectionId: c.id }, { includeDeleted })));
        world.collections.forEach((c, i) => {
          expect(listed.get(c.id) ?? 'none', `${u.role} ${c.id} includeDeleted=${String(includeDeleted)}`).toBe(decided[i]?.access);
        });
      }
    }
    // Explicit limit: a sequential database comparison over the whole world, 5 s default is for tests of one statement.
  }, 60_000);

  it('with includeDeleted a deleted page and a deleted collection decide as if live', async () => {
    const a = createAuthorizer(createAccessStore(db));
    const pageRow = accessCases.findIndex((c) => c.name === 'includeDeleted, member: deleted page with default read_write: read-write');
    const colRow = accessCases.findIndex((c) => c.name === 'includeDeleted, viewer: page in a deleted collection with default read_write: read-only');
    const p = ids[pageRow];
    const c = ids[colRow];
    if (!p || !c) throw new Error('rows missing');
    expect(await a.check({ userId: p.userId, pageId: p.pageId })).toMatchObject({ access: 'none', reason: 'deleted' });
    expect(await a.check({ userId: p.userId, pageId: p.pageId }, { includeDeleted: true })).toMatchObject({ access: 'read-write' });
    expect(await a.checkCollection({ userId: c.userId, collectionId: c.collectionId })).toMatchObject({ access: 'none', reason: 'deleted' });
    expect(await a.checkCollection({ userId: c.userId, collectionId: c.collectionId }, { includeDeleted: true })).toEqual({ access: 'read-only' });
  });

  it('one statement for checkMany with 50 requests, one for collectionFacts with 50 requests, one for visibleCollections', async () => {
    const counter = counting(db);
    const a = createAuthorizer(createAccessStore(counter.db));
    const fifty = Array.from({ length: 50 }, (_, i) => ids[i % ids.length]).flatMap((id) => (id ? [id] : []));
    await a.checkMany(fifty.map((id) => ({ userId: id.userId, pageId: id.pageId })));
    expect(counter.statements()).toBe(1);
    counter.reset();
    await createAccessStore(counter.db).collectionFacts(fifty.map((id) => ({ userId: id.userId, collectionId: id.collectionId })));
    expect(counter.statements()).toBe(1);
    counter.reset();
    await a.visibleCollections(ids[0]?.userId ?? '');
    expect(counter.statements()).toBe(1);
  });

  it('malformed ids are denied without reaching the database, and an empty request list sends nothing', async () => {
    const counter = counting(db);
    const a = createAuthorizer(createAccessStore(counter.db));
    expect(await a.check({ userId: 'not-a-uuid', pageId: 'x' })).toEqual({ access: 'none', reason: 'no-user' });
    expect(await a.checkCollection({ userId: "'; drop table users; --", collectionId: 'x' })).toEqual({ access: 'none', reason: 'no-user' });
    expect(await a.visibleCollections('nope')).toEqual([]);
    expect(await a.checkMany([])).toEqual([]);
    expect(counter.statements()).toBe(0);
  });

  it('rejects when the database is unreachable', async () => {
    const down = createDatabase(appUrl('none', '127.0.0.1:1'), { connectionTimeoutMs: 300, closeTimeoutMs: 100 });
    try {
      await expect(createAccessStore(down).facts([{ userId: ids[0]?.userId ?? '', pageId: ids[0]?.pageId ?? '' }])).rejects.toThrow();
    } finally {
      await down.close();
    }
  });
});
