import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { insertCollection, insertPage, insertSql, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../../server/support/harness.js';

// M7-T14: the vector of a chunk is stored in the row (migration 0013). Without it a 768-dimension vector (3 KB) goes to the TOAST table and a search reads every one from there.
const DB = 'grimoire_m7t14_storage';
const run = (text: string) => sqlAdmin(DB, text);
const vector = (n: number): string => `[${Array.from({ length: n }, (_, i) => String(((i * 7) % 13) / 13 + 0.01)).join(',')}]`;
let app: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  app = createDatabase(appUrl(DB), { maxConnections: 2 });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await dropTestDatabase(DB);
});

describe('migration 0013', () => {
  it("sets the storage of page_chunks.embedding to 'main' (the default for a vector is 'extended', which is what moves it out of the row)", async () => {
    const rows = (await run(`select attstorage::text as storage from pg_attribute where attrelid = 'page_chunks'::regclass and attname = 'embedding'`)) as { storage: string }[];
    expect(rows).toEqual([{ storage: 'm' }]);
    // The control: another column the migration did not touch keeps its default, so the query above reads what it says.
    const other = (await run(`select attstorage::text as storage from pg_attribute where attrelid = 'page_chunks'::regclass and attname = 'content_hash'`)) as { storage: string }[];
    expect(other).toEqual([{ storage: 'x' }]);
  });

  it('keeps 768-dimension vectors in the row: after writing a few hundred, the TOAST table of page_chunks holds nothing', async () => {
    await run(`insert into tenants (id, name) values ('T-store', 'Store') on conflict do nothing`);
    const user = await insertUser(run, { tenant_id: 'T-store' });
    const collection = await insertCollection(run, { created_by: user, tenant_id: 'T-store' });
    const page = await insertPage(run, { collection_id: collection, created_by: user, tenant_id: 'T-store', markdown_hash: raw(`decode(repeat('01', 32), 'hex')`) });
    for (let i = 0; i < 300; i += 1) {
      await run(
        insertSql('page_chunks', {
          page_id: page,
          tenant_id: 'T-store',
          chunk_index: i,
          model: 'm-768',
          content_hash: raw(`decode(repeat('02', 32), 'hex')`),
          char_start: 0,
          char_end: 10,
          token_count: 3,
          embedding: vector(768),
        }),
      );
    }
    const sizes = (await run(`select pg_relation_size('page_chunks') as heap, coalesce(pg_relation_size(reltoastrelid), 0) as toast from pg_class where oid = 'page_chunks'::regclass`)) as {
      heap: string;
      toast: string;
    }[];
    expect(Number(sizes[0]?.toast)).toBe(0);
    expect(Number(sizes[0]?.heap)).toBeGreaterThan(300 * 3000); // the 300 vectors (3 KB each) are in the heap
  }, 120_000);
});
