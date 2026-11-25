import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// A database where the administrator has not made pgvector available: the migration says what to do, changes nothing and exits 1, instead of a bare "type vector does not exist".
const BARE = 'grimoire_m7t11_noextension';
const migrate = () => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(BARE) });

beforeAll(async () => {
  requireBuild();
  await sqlAdmin('postgres', `drop database if exists ${BARE} with (force)`);
  await sqlAdmin('postgres', `create database ${BARE} template template0 owner grimoire_migrator`); // template0: no extension, whatever template1 carries
}, 60_000);
afterAll(async () => { await dropTestDatabase(BARE); });

describe('grimoire migrate without pgvector', () => {
  it('stops at the embedding migration, names the extension and how to install it, and leaves nothing applied: Kysely runs the whole batch in one transaction', async () => {
    const run = await migrate();
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/vector extension/i);
    expect(run.output).toMatch(/db-setup/);
    expect(await sqlAdmin(BARE, `select 1 from information_schema.tables where table_schema = 'public'`)).toEqual([]); // not even `pages`
    expect(await sqlAdmin(BARE, `select 1 from information_schema.tables where table_name in ('page_chunks', 'page_embedding_state')`)).toEqual([]);
  }, 120_000);

  it('goes through once the administrator installs it, and is then repeatable', async () => {
    await sqlAdmin(BARE, 'create extension if not exists vector');
    expect((await migrate()).code).toBe(0);
    expect((await migrate()).code).toBe(0);
    expect(await sqlAdmin(BARE, `select count(*)::int as n from information_schema.tables where table_name in ('page_chunks', 'page_embedding_state')`)).toEqual([{ n: 2 }]);
  }, 120_000);
});
