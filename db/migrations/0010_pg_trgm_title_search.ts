import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Search by title uses `pg_trgm` (the `%` operator and `similarity()`): every database search runs against needs it, whatever made the database.
// `db/init/02-extensions.sql` creates it on a fresh local volume and `grimoire db-setup` on a managed service, so this statement is then a no-op; on any other
// database the migration role creates it (a trusted extension, like `citext` in 0004). 0006 skipped the title index when the extension was absent: it is made here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists pg_trgm`.execute(db);
  await sql`create index if not exists pages_title_trgm_idx on pages using gin (title gin_trgm_ops)`.execute(db);
}
