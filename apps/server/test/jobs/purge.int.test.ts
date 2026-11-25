import { createTenants, createTrash } from '@tektum/grimoire-adapter-db-kysely';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPurge } from '../../src/jobs/purge.js';
import { jobsDatabase, seedDeletedPage, seedTenant } from './support.js';

let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase('grimoire_m7t02_purge'); }, 120_000);
afterAll(async () => { await db?.drop(); });

const count = async (table: string, column: string, id: string): Promise<number> => {
  const rows = (await db.sql(`select count(*)::int as n from ${table} where ${column} = '${id}'`)) as { n: number }[];
  return rows[0]?.n ?? 0;
};

describe('the purge job on a real database', () => {
  it('removes a batch deleted 31 days ago with its revisions, attachment rows and objects, in every tenant, and leaves one deleted 29 days ago', async () => {
    const files = new FakeFileStorage();
    const a = await seedTenant(db.sql, 'T-purge-a');
    const b = await seedTenant(db.sql, 'T-purge-b');
    const old = await seedDeletedPage(db.sql, a, 31);
    const older = await seedDeletedPage(db.sql, b, 90);
    const young = await seedDeletedPage(db.sql, a, 29);
    for (const { key } of [old, young]) await files.put(key, new Uint8Array([1]), { size: 1, contentType: 'image/png' }); // the object of `older` is already absent
    const deps = { tenants: createTenants(db.ops), trash: createTrash(db.app), deleteFiles: async (keys: readonly string[]) => { for (const k of keys) await files.delete(k); }, now: () => Date.now() };

    expect(await runPurge(deps, new AbortController().signal)).toEqual({ pages: 2, objects: 2 });
    for (const page of [old, older]) {
      expect(await count('pages', 'id', page.id)).toBe(0);
      expect(await count('revisions', 'page_id', page.id)).toBe(0);
      expect(await count('attachments', 'page_id', page.id)).toBe(0);
    }
    expect(await files.head(old.key).then(() => true, () => false)).toBe(false);
    expect([await count('pages', 'id', young.id), await count('attachments', 'page_id', young.id)]).toEqual([1, 1]);
    expect(await files.head(young.key).then(() => true, () => false)).toBe(true);

    expect(await runPurge(deps, new AbortController().signal)).toEqual({ pages: 0, objects: 0 });
    expect(await count('pages', 'id', young.id)).toBe(1);
    expect(await runPurge({ ...deps, now: () => Date.now() + 2 * 86_400_000 }, new AbortController().signal)).toEqual({ pages: 1, objects: 1 });
    expect(await count('audit_events', 'target_id', old.id)).toBe(1); // one `page.purged` row, in the tenant of the batch
  }, 60_000);
});
