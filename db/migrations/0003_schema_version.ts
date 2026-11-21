import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// /readyz must know the newest applied migration, but the runtime role has no right on Kysely's bookkeeping tables (0001).
// This one function returns only the latest name; it runs with the owner's rights, with a fixed search path.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function grimoire_schema_version() returns text
      language sql stable security definer set search_path = pg_catalog, public
      as $$ select max(name) from public.kysely_migration $$`.execute(db);
  await sql`revoke all on function grimoire_schema_version() from public`.execute(db);
  await sql`grant execute on function grimoire_schema_version() to grimoire_app`.execute(db);
}
