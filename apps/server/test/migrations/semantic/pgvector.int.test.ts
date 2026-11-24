import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, sqlAdmin } from '../../server/support/harness.js';

// M7-T10 (R2.46): the Compose database has pgvector. The database `grimoire` is made by the image's init step (`db/init/03-vector.sql`); the scratch database below stands in for
// a migrated one (an extension is per database) and is where a table with a `vector` column is tried. The version is read, not assumed: it is 0.8.5 on the default image
// and 0.8.7 on the second image of `make test-pgvector-087`, whose queries use only what 0.8.0 has.
const SCRATCH = 'grimoire_t_pgvector';
const BARE = 'grimoire_t_pgvector_bare'; // no extension: where the runtime role's attempt to create one is judged on its own
const VERSION = process.env['GRIMOIRE_TEST_PGVECTOR_VERSION'] ?? '0.8.5';

beforeAll(async () => {
  await createTestDatabase(SCRATCH, false);
  await createTestDatabase(BARE, false);
  await sqlAdmin(SCRATCH, 'create extension if not exists vector');
}, 60_000);
afterAll(async () => { await dropTestDatabase(SCRATCH); await dropTestDatabase(BARE); });

describe('pgvector in the database image', () => {
  it('is installed in the database the image creates, at the version of the image', async () => {
    const rows = await sqlAdmin<{ extversion: string }>('grimoire', `select extversion from pg_extension where extname = 'vector'`);
    expect(rows.map((r) => r.extversion)).toEqual([VERSION]);
  });

  it('lets the runtime role use the type and the distance operator, and does not let it create the extension', async () => {
    const app = createDatabase(appUrl(SCRATCH), { maxConnections: 1 });
    try {
      const rows = await app.query<{ d: string }>(`select ('[1,2,3]'::vector <=> '[1,2,4]'::vector)::text as d`);
      expect(Number(rows[0]?.d)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
    const bare = createDatabase(appUrl(BARE), { maxConnections: 1 });
    try {
      await expect(bare.query('create extension vector')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await bare.close();
    }
  });

  it('keeps a 768-dimension and a 384-dimension vector in one untyped column', async () => {
    await sqlAdmin(SCRATCH, 'create table dims (id int primary key, v vector)');
    const literal = (n: number): string => `[${Array.from({ length: n }, (_, i) => String(i % 7)).join(',')}]`;
    await sqlAdmin(SCRATCH, `insert into dims values (1, '${literal(768)}'), (2, '${literal(384)}')`);
    const rows = await sqlAdmin<{ id: number; n: number }>(SCRATCH, 'select id, vector_dims(v) as n from dims order by id');
    expect(rows.map((r) => [r.id, r.n])).toEqual([[1, 768], [2, 384]]);
  });
});
