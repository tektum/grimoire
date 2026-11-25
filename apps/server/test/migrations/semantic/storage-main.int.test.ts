import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { insertCollection, insertPage, insertSql, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../../server/support/harness.js';

// M7-T14: the vector of a chunk is stored in the row (migration 0013). Without it a 768-dimension vector (3 KB) goes to the TOAST table and a search reads every one from there.
const DB = 'grimoire_m7t14_storage';
const run = (text: string) => sqlAdmin(DB, text);
// Values that do not compress: a vector of a repeating pattern shrinks to a hundred bytes under pglz and then stays in the row whatever the storage setting is, which proves nothing. These come from a
// small seeded generator (mulberry32), as real embeddings do not compress either.
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const vector = (n: number, random: () => number): string => `[${Array.from({ length: n }, () => String(random() * 2 - 1)).join(',')}]`;
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

  // Writes the same 300 vectors (the same seed) into `table` and reads what the storage did with them: how many rows, the stored size of the smallest and the largest vector, the size of the TOAST
  // table and of the heap. `page_chunks_scratch` is a copy of the table (its columns, defaults and storage settings; no foreign key), so a case can change the setting without touching the real one.
  async function written(table: string, page: string): Promise<{ n: number; smallest: number; largest: number; toast: number; heap: number }> {
    const random = seeded(11);
    for (let i = 0; i < 300; i += 1) {
      await run(
        insertSql(table, {
          page_id: page,
          tenant_id: 'T-store',
          chunk_index: i,
          model: 'm-768',
          content_hash: raw(`decode(repeat('02', 32), 'hex')`),
          char_start: 0,
          char_end: 10,
          token_count: 3,
          embedding: vector(768, random),
        }),
      );
    }
    const [rows] = (await run(`select count(*)::int as n, min(pg_column_size(embedding))::int as smallest, max(pg_column_size(embedding))::int as largest from ${table}`)) as {
      n: number;
      smallest: number;
      largest: number;
    }[];
    const [sizes] = (await run(`select coalesce(pg_relation_size(reltoastrelid), 0)::bigint as toast, pg_relation_size('${table}')::bigint as heap from pg_class where oid = '${table}'::regclass`)) as {
      toast: string;
      heap: string;
    }[];
    return { n: rows?.n ?? 0, smallest: rows?.smallest ?? 0, largest: rows?.largest ?? 0, toast: Number(sizes?.toast), heap: Number(sizes?.heap) };
  }
  let page = '';
  beforeAll(async () => {
    await run(`insert into tenants (id, name) values ('T-store', 'Store') on conflict do nothing`);
    const user = await insertUser(run, { tenant_id: 'T-store' });
    const collection = await insertCollection(run, { created_by: user, tenant_id: 'T-store' });
    page = await insertPage(run, { collection_id: collection, created_by: user, tenant_id: 'T-store', markdown_hash: raw(`decode(repeat('01', 32), 'hex')`) });
  });

  it('keeps 768-dimension vectors in the row: 300 vectors that do not compress leave the TOAST table of page_chunks empty, and the heap holds them', async () => {
    const seen = await written('page_chunks', page);
    expect(seen.n).toBe(300); // the rows are there, so what follows is about 300 rows and not about fewer
    // 4 bytes a dimension and the header, uncompressed: a vector that was compressed would be smaller.
    expect(seen.smallest).toBeGreaterThanOrEqual(3000);
    expect(seen.largest).toBeLessThanOrEqual(3100);
    expect(seen.toast).toBe(0);
    expect(seen.heap).toBeGreaterThan(300 * 3000);
  }, 120_000);

  it('can tell the two layouts apart: the same 300 vectors in a copy of the table set to `extended` go out of line (TOAST holds them, the heap does not), so the case above is not passing on anything', async () => {
    await run('create table page_chunks_scratch (like page_chunks including defaults including constraints including storage)');
    await run('alter table page_chunks_scratch alter column embedding set storage extended');
    const seen = await written('page_chunks_scratch', page);
    expect(seen.n).toBe(300);
    expect(seen.toast).toBeGreaterThan(300 * 3000);
    expect(seen.heap).toBeLessThan(300 * 1000);
    // And the copy started from the real setting: that is what the migration's column is compared against.
    const [control] = (await run(`select attstorage::text as storage from pg_attribute where attrelid = 'page_chunks'::regclass and attname = 'embedding'`)) as { storage: string }[];
    expect(control?.storage).toBe('m');
  }, 120_000);
});
