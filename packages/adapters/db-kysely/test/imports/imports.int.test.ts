import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
        repo: createImportRepo(t.app), tenantId: 'legacy', otherTenantId: 'other', now: NOW,
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
