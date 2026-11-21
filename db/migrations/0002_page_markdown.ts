import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// The Markdown copy of a page next to its Yjs state, saved in the same transaction.
// `markdown_stale_since` marks a page whose Markdown is older than its state. `last_edited_by` has no foreign key until the users table exists. Hashes are not backfilled: existing rows have no Markdown yet.
// Grants are explicit, as in 0001 (no TRUNCATE, REFERENCES or TRIGGER).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table pages
      add column markdown text,
      add column text_content text,
      add column markdown_hash bytea check (markdown_hash is null or octet_length(markdown_hash) = 32),
      add column last_edited_by uuid,
      add column last_edited_at timestamptz,
      add column markdown_stale_since timestamptz`.execute(db);
  // Set when a save stored the state without fresh Markdown, cleared by the save that stores it; the sweep and the on-load path read it.
  await sql`create index pages_markdown_stale_idx on pages (markdown_stale_since) where markdown_stale_since is not null`.execute(db);
  await sql`grant select, insert, update, delete on pages to grimoire_app`.execute(db);
}
