import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Minimal table for the collaboration proof (M1-T09). The full product schema arrives in M4.
// Explicit least-privilege grant to the documented runtime role name (db/init/01-roles.sql); no TRUNCATE, REFERENCES or TRIGGER.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table pages (
      id uuid primary key default gen_random_uuid(),
      ydoc bytea,
      ydoc_size integer,
      state_epoch integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db);
  await sql`grant select, insert, update, delete on pages to grimoire_app`.execute(db);
}
