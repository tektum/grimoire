import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Minimal table for the collaboration host; the product schema is extended by later migrations.
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
