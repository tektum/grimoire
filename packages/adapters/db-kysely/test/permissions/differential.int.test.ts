import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import type { Permission } from '@tektum/grimoire-core/ports/access-store';
import type { Role } from '@tektum/grimoire-core/ports/user-store';
import { uuidOf } from '@tektum/grimoire-core/testing/access-cases';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { createMigratedDatabase, dropDatabase, loadWorld, sqlAs, urlFor } from './support.js';

// Differential test: the pure decision over the in-memory facts and over the facts the SQL reads must agree for every (user, page) and (user, collection),
// for every worlds drawn at random. The seed is printed in every failure message; GRIMOIRE_ACCESS_SEED=<n> replays one run.
const DB = `grimoire_m3t04_diff_${String(process.pid)}`;
const SEED = Number(process.env.GRIMOIRE_ACCESS_SEED ?? Date.now() % 2_000_000_000);
const WORLDS = 10;
const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';
const UNFILED = '00000000-0000-4000-8000-000000000002';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWorld(rand: () => number, unfiledPosition: string): World {
  const int = (n: number): number => Math.floor(rand() * n);
  const chance = (p: number): boolean => rand() < p;
  const w = emptyWorld();
  const roles: Role[] = ['admin', 'member', 'member', 'viewer', 'viewer'];
  const userCount = 6 + int(8), groupCount = 2 + int(5), collectionCount = 4 + int(8), pageCount = 20 + int(30);
  for (let i = 0; i < userCount; i++) w.users.push({ id: uuidOf('user', i + 1), role: roles[int(roles.length)] ?? 'viewer', suspended: chance(0.15) });
  for (let i = 0; i < groupCount; i++) w.groups.push({ id: uuidOf('group', i + 1) });
  for (const g of w.groups) for (const u of w.users) if (chance(0.3)) w.members.push({ groupId: g.id, userId: u.id });
  const perms: (Permission | null)[] = [null, null, 'read', 'read_write'];
  // The migration's own "Unfiled" collection (no default permission) is part of every world; the loader does not insert it again.
  w.collections.push({ id: UNFILED, deleted: false, defaultPermission: null, position: unfiledPosition });
  for (let i = 0; i < collectionCount; i++) {
    w.collections.push({ id: uuidOf('collection', i + 1), deleted: chance(0.15), defaultPermission: perms[int(perms.length)] ?? null, position: `a${String(i).padStart(4, '0')}` });
  }
  const level = (): Permission => (chance(0.5) ? 'read' : 'read_write');
  for (const c of w.collections) {
    for (const u of w.users) if (chance(0.15)) w.access.push({ collectionId: c.id, userId: u.id, permission: level() });
    for (const g of w.groups) if (chance(0.25)) w.access.push({ collectionId: c.id, groupId: g.id, permission: level() });
  }
  for (let i = 0; i < pageCount; i++) {
    const c = w.collections[int(w.collections.length)];
    if (c) w.pages.push({ id: uuidOf('page', i + 1), collectionId: c.id, deleted: chance(0.15), epoch: int(50) });
  }
  // The store lists collections by position (byte order, collate "C"): so does the model.
  w.collections.sort((a, b) => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0));
  return w;
}

let db: KyselyDatabase;
/** The stored position of "Unfiled": the model reads it after migrating, so a later renumbering cannot desynchronise it. */
let unfiledPosition = '';
beforeAll(async () => {
  await createMigratedDatabase(DB);
  unfiledPosition = (await sqlAs<{ position: string }>(urlFor('grimoire_admin', DB), 'select position from collections where id = $1', [UNFILED]))[0]?.position ?? '';
  expect(unfiledPosition).not.toBe('');
  db = createDatabase(urlFor('grimoire_app', DB));
}, 180_000);
afterAll(async () => {
  await db.close();
  await dropDatabase(DB);
});

async function clear(): Promise<void> {
  const admin = urlFor('grimoire_admin', DB);
  for (const t of ['pages', 'collection_access', 'group_members', 'groups']) await sqlAs(admin, `delete from ${t}`);
  await sqlAs(admin, 'delete from collections where id <> $1', [UNFILED]);
  await sqlAs(admin, 'delete from users where id <> $1', [SYSTEM_USER]);
}

describe(`SQL form against the pure decision (seed ${String(SEED)})`, () => {
  it(`agrees on every triple of ${String(WORLDS)} random worlds`, async () => {
    const rand = prng(SEED);
    const sqlAuth = createAuthorizer(createAccessStore(db));
    let triples = 0;
    for (let n = 0; n < WORLDS; n++) {
      await clear();
      const world = randomWorld(rand, unfiledPosition);
      await loadWorld(DB, world);
      const fakeAuth = createAuthorizer(createFakeAccessStore(world));
      const absentUser = uuidOf('absent', 1), absentPage = uuidOf('absent', 2), absentCollection = uuidOf('absent', 3);
      const users = [...world.users.map((u) => u.id), absentUser];
      const pages = [...world.pages.map((p) => p.id), absentPage];
      const requests = users.flatMap((userId) => pages.map((pageId) => ({ tenantId: 'legacy', userId, pageId })));
      const fromSql = await sqlAuth.checkMany(requests);
      const fromFake = await fakeAuth.checkMany(requests);
      requests.forEach((r, i) => {
        const where = `seed ${String(SEED)} world ${String(n)} user ${r.userId} page ${r.pageId}`;
        expect(fromSql[i], where).toEqual(fromFake[i]);
        triples++;
      });
      for (const includeDeleted of [false, true]) {
        for (const r of requests.filter((_, i) => i % 7 === 0)) {
          expect(await sqlAuth.check(r, { includeDeleted }), `seed ${String(SEED)} world ${String(n)} includeDeleted ${String(includeDeleted)} ${r.userId} ${r.pageId}`).toEqual(await fakeAuth.check(r, { includeDeleted }));
          triples++;
        }
        const collections = [...world.collections.map((c) => c.id), absentCollection];
        const cReqs = users.flatMap((userId) => collections.map((collectionId) => ({ tenantId: 'legacy', userId, collectionId })));
        const cFacts = await createAccessStore(db).collectionFacts(cReqs);
        expect(cFacts.length).toBe(cReqs.length);
        for (const r of cReqs) {
          const where = `seed ${String(SEED)} world ${String(n)} includeDeleted ${String(includeDeleted)} user ${r.userId} collection ${r.collectionId}`;
          expect(await sqlAuth.checkCollection(r, { includeDeleted }), where).toEqual(await fakeAuth.checkCollection(r, { includeDeleted }));
          triples++;
        }
        for (const userId of users) {
          const where = `seed ${String(SEED)} world ${String(n)} includeDeleted ${String(includeDeleted)} visibleCollections of ${userId}`;
          expect(await sqlAuth.visibleCollections('legacy', userId, { includeDeleted }), where).toEqual(await fakeAuth.visibleCollections('legacy', userId, { includeDeleted }));
          triples++;
        }
      }
    }
    console.log(`access differential: seed ${String(SEED)}, ${String(triples)} comparisons`);
    expect(triples).toBeGreaterThan(3000);
  }, 120_000);
});
