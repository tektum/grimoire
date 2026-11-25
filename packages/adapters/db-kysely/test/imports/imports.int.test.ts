import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importRepoConformance } from '@tektum/grimoire-core/testing/import-repo-conformance';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createImportRepo } from '../../src/imports.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let collectionId: string;
let userId: string;
const ordering = new FakeOrdering();
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  t = await createTestDatabase('imports');
  userId = await addUser(t.app, 'ada', 'admin');
  collectionId = (await createCollections(t.app).append('legacy', { name: 'imports', createdBy: userId }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });
// A tenant has one running import (migration 0012): every case starts from a tenant that has none.
// The runtime role may not delete (migration 0005 grants select, insert and update), so the schema owner's connection clears them; the items go with their import.
beforeEach(async () => { await t.admin.query(`delete from imports where tenant_id = 'legacy'`); });

const seed = async (status: string): Promise<{ id: string }> => {
  const rows = await t.app.query<{ id: string }>(
    `insert into imports (tenant_id, target_collection_id, source, status, created_by) values ('legacy', $1, 'markdown_zip', $2, $3) returning id`, [collectionId, status, userId],
  );
  return rows[0] as { id: string };
};

describe('the PostgreSQL ImportRepo meets the conformance cases', () => {
  for (const c of importRepoConformance) {
    it(c.name, async () => {
      await c.run({
        repo: createImportRepo(t.app), tenantId: 'legacy', otherTenantId: 'other', userId, now: NOW, collectionId,
        seedStatus: async (id, status) => { await t.app.query('update imports set status = $2 where id = $1', [id, status]); },
        seed: async (status) => {
          const made = await seed(status);
          const row = await createImportRepo(t.app).get('legacy', made.id);
          if (row === undefined) throw new Error('the seeded import is missing');
          return row;
        },
      });
    }, 30_000);
  }
});

describe('what only the database does', () => {
  it('scanItems and listItems order by the numeric id, not by the text of it (ids 9, 10, 11 are in that order)', async () => {
    const repo = createImportRepo(t.app);
    const made = await seed('running');
    // The id is a bigserial that the API shows as text: a sort on the text column would put "10" before "9". Cross the digit boundary on purpose.
    await t.admin.query(`select setval('import_items_id_seq', 5)`);
    await repo.addItems('legacy', made.id, Array.from({ length: 12 }, (_, i) => ({ path: `p${String(i).padStart(2, '0')}.md`, kind: 'page' as const })));
    const ids = (await repo.scanItems('legacy', made.id, { limit: 50 })).map((i) => i.id);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => String(6 + i)));
    const paged: string[] = [];
    for (let after: string | undefined; ;) {
      const batch = await repo.scanItems('legacy', made.id, after === undefined ? { limit: 5 } : { limit: 5, afterId: after });
      if (batch.length === 0) break;
      paged.push(...batch.map((i) => i.id));
      after = batch.at(-1)?.id;
    }
    expect(paged).toEqual(ids);
    const settled = await repo.pending('legacy', made.id, 'page', 12);
    for (const i of settled) await repo.settle('legacy', made.id, i.id, { status: 'skipped', message: 'ignored' });
    const listed: string[] = [];
    for (let after: string | undefined; ;) {
      const batch = await repo.listItems('legacy', made.id, after === undefined ? { limit: 5 } : { limit: 5, afterId: after });
      if (batch.length === 0) break;
      listed.push(...batch.map((i) => i.id));
      after = batch.at(-1)?.id;
    }
    expect(listed).toEqual(ids);
  });

  it('two batches that race on the same paths add each path once', async () => {
    const repo = createImportRepo(t.app);
    const made = await seed('running');
    const batch = Array.from({ length: 200 }, (_, i) => ({ path: `p${String(i)}.md`, kind: 'page' as const }));
    const [a, b] = await Promise.all([repo.addItems('legacy', made.id, batch), repo.addItems('legacy', made.id, batch)]);
    expect(a + b).toBe(200);
    const rows = await t.app.query<{ n: number }>('select count(*)::int as n from import_items where import_id = $1', [made.id]);
    expect(rows[0]?.n).toBe(200);
  });

  it('a path repeated inside one batch is added once', async () => {
    const made = await seed('running');
    expect(await createImportRepo(t.app).addItems('legacy', made.id, [{ path: 'a.md', kind: 'page' }, { path: 'a.md', kind: 'page' }])).toBe(1);
  });

  it('items carry the tenant of their import', async () => {
    const made = await seed('running');
    await createImportRepo(t.app).addItems('legacy', made.id, [{ path: 'a.md', kind: 'page' }]);
    const rows = await t.app.query<{ tenant_id: string }>('select tenant_id from import_items where import_id = $1', [made.id]);
    expect(rows.map((r) => r.tenant_id)).toEqual(['legacy']);
  });
});
