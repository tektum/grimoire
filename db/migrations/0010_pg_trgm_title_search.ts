import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Search by title uses `pg_trgm` (the `%` operator and `similarity()`): every database search runs against needs it, whatever made the database.
// `db/init/02-extensions.sql` creates it on a fresh local volume and `grimoire db-setup` on a managed service, so this statement is then a no-op. The migration role has only
// CONNECT on the database, so on a managed database that was set up before this migration and not set up again it cannot create the extension, even a trusted one: it says so and
// names the step, instead of a bare permission error that blocks every later migration. 0006 skipped the title index when the extension was absent: it is made here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      create extension if not exists pg_trgm;
    exception when insufficient_privilege then
      raise exception 'the pg_trgm extension is not installed and this role cannot create it: run "grimoire db-setup" again (as the database administrator) before "grimoire migrate"; a deploy runs it first, see docs/operations/database-setup.md';
    end $$`.execute(db);
  await sql`create index if not exists pages_title_trgm_idx on pages using gin (title gin_trgm_ops)`.execute(db);
}
