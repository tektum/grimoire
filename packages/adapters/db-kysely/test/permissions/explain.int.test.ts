import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyWorld, createFakeAccessStore } from '@tektum/grimoire-core/testing/fake-access-store';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import { uuidOf } from '@tektum/grimoire-core/testing/access-cases';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { createMigratedDatabase, dropDatabase, loadWorld, sqlAs, urlFor } from './support.js';

// The plans of the main queries on 10,000 pages, 500 users and 200 groups. Printed (bun run test:integration shows them with --reporter verbose);
// the assertions only say that the big tables are reached through an index.
const DB = `grimoire_m3t04_explain_${String(process.pid)}`;
let db: KyselyDatabase;
const recorded: { sql: string; params: readonly unknown[] }[] = [];

function bigWorld(): World {
  const w = emptyWorld();
  for (let i = 1; i <= 500; i++) w.users.push({ id: uuidOf('user', i), role: i % 50 === 0 ? 'admin' : i % 3 === 0 ? 'viewer' : 'member', suspended: i % 97 === 0 });
  for (let i = 1; i <= 200; i++) w.groups.push({ id: uuidOf('group', i) });
  for (let i = 1; i <= 500; i++) for (let k = 0; k < 4; k++) w.members.push({ groupId: uuidOf('group', ((i * 7 + k * 31) % 200) + 1), userId: uuidOf('user', i) });
  const seen = new Set<string>();
  w.members = w.members.filter((m) => !seen.has(m.groupId + m.userId) && seen.add(m.groupId + m.userId));
  for (let i = 1; i <= 100; i++) {
    const id = uuidOf('collection', i);
    w.collections.push({ id, deleted: i % 20 === 0, defaultPermission: i % 4 === 0 ? 'read' : null, position: `a${String(i).padStart(4, '0')}` });
    for (let k = 0; k < 8; k++) w.access.push({ collectionId: id, groupId: uuidOf('group', ((i * 13 + k * 17) % 200) + 1), permission: k % 2 ? 'read' : 'read_write' });
    for (let k = 0; k < 6; k++) w.access.push({ collectionId: id, userId: uuidOf('user', ((i * 11 + k * 29) % 500) + 1), permission: 'read' });
  }
  for (let i = 1; i <= 10_000; i++) w.pages.push({ id: uuidOf('page', i), collectionId: uuidOf('collection', (i % 100) + 1), deleted: i % 50 === 0, epoch: i % 9 });
  return w;
}

beforeAll(async () => {
  await createMigratedDatabase(DB);
  await loadWorld(DB, bigWorld());
  await sqlAs(urlFor('grimoire_admin', DB), 'analyze');
  db = createDatabase(urlFor('grimoire_app', DB));
}, 240_000);
afterAll(async () => {
  await db.close();
  await dropDatabase(DB);
});

async function plan(run: (store: ReturnType<typeof createAccessStore>) => Promise<unknown>): Promise<string> {
  recorded.length = 0;
  await run(createAccessStore({ query: (sql, params) => { recorded.push({ sql, params: params ?? [] }); return db.query(sql, params); } }));
  const q = recorded[0];
  if (!q) throw new Error('no statement');
  const rows = await sqlAs<{ 'QUERY PLAN': string }>(urlFor('grimoire_admin', DB), `explain (analyze, timing off) ${q.sql}`, [...q.params]);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

describe('plans on 10,000 pages, 500 users, 200 groups', () => {
  const pageRequests = Array.from({ length: 50 }, (_, i) => ({ userId: uuidOf('user', i + 1), pageId: uuidOf('page', i * 37 + 1) }));
  const collectionRequests = Array.from({ length: 50 }, (_, i) => ({ userId: uuidOf('user', i + 1), collectionId: uuidOf('collection', (i % 100) + 1) }));
  const cases: [string, (s: ReturnType<typeof createAccessStore>) => Promise<unknown>][] = [
    ['facts (50 requests)', (s) => s.facts(pageRequests)],
    ['collectionFacts (50 requests)', (s) => s.collectionFacts(collectionRequests)],
    ['visibleCollections (member)', (s) => s.visibleCollections(uuidOf('user', 1))],
  ];
  for (const [name, fn] of cases) {
    it(`${name}: no sequential scan of collection_access or group_members`, async () => {
      const text = await plan(fn);
      console.log(`EXPLAIN ${name}\n${text}`);
      expect(text.length).toBeGreaterThan(0);
      for (const t of ['collection_access', 'group_members']) expect(text, `${t} scanned sequentially`).not.toMatch(new RegExp(`Seq Scan on ${t}\\b`));
    });
  }
  it('facts for 3 requests reaches pages through its primary key', async () => {
    const text = await plan((s) => s.facts(pageRequests.slice(0, 3)));
    console.log(`EXPLAIN facts (3 requests)\n${text}`);
    expect(text).toMatch(/Index Scan using pages_(pkey|id_collection_uq|id_tenant_uq)/);
    expect(text).not.toMatch(/Seq Scan on pages\b/);
  });
  it('the answers on this world are the fake store\'s', async () => {
    const world = bigWorld();
    const a = createAuthorizer(createAccessStore(db));
    const f = createAuthorizer(createFakeAccessStore(world));
    expect(await a.checkMany(pageRequests)).toEqual(await f.checkMany(pageRequests));
    expect((await a.visibleCollections(uuidOf('user', 1))).filter((r) => r.collectionId !== '00000000-0000-4000-8000-000000000002')).toEqual(await f.visibleCollections(uuidOf('user', 1)));
  });
});
