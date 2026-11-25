import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// A managed database as `db-setup` leaves it: the administrator owns the database, the migration role has CONNECT and owns the schema `public`, and nothing more. Here it was set up by
// a release that made `citext` only; the next release's migration 0010 needs `pg_trgm`, which the migration role cannot create (not even a trusted extension: that takes CREATE on the database).
const DB = 'grimoire_m7_pgtrgm';
const migrate = () => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });

beforeAll(async () => {
  requireBuild();
  await sqlAdmin('postgres', `drop database if exists ${DB} with (force)`);
  await sqlAdmin('postgres', `create database ${DB} template template0`); // owned by the administrator
  await sqlAdmin(DB, `revoke all on database ${DB} from public; grant connect on database ${DB} to grimoire_migrator; alter schema public owner to grimoire_migrator; create schema pgboss authorization grimoire_migrator; create extension citext`); // as `db-setup` leaves it: the job queue's schema belongs to the migration role too
}, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('migration 0010 on a database that db-setup has not set up again', () => {
  it('stops with a message that names db-setup and docs/operations/database-setup.md, and applies nothing', async () => {
    const run = await migrate();
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/pg_trgm/);
    expect(run.output).toMatch(/grimoire db-setup/);
    expect(await sqlAdmin(DB, `select 1 from information_schema.tables where table_name = 'pages'`)).toEqual([]);
  }, 120_000);

  it('goes through once the administrator has made the extension, as db-setup does', async () => {
    // What `db-setup` makes: every extension the migrations need, not only this one, or the first later migration that needs another stops the run (0011 needs `vector`).
    await sqlAdmin(DB, 'create extension pg_trgm');
    await sqlAdmin(DB, 'create extension if not exists vector');
    const run = await migrate();
    expect(run.code, run.output).toBe(0);
    expect(await sqlAdmin(DB, `select indexname from pg_indexes where indexname = 'pages_title_trgm_idx'`)).toEqual([{ indexname: 'pages_title_trgm_idx' }]);
  }, 120_000);
});
