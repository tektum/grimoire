import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// History, files, imports, audit and idempotency tables. Raw SQL, as in 0001 to 0004. It adds only what 0001 to 0004 did not create.
// Users are never deleted in v1 (suspension only): every reference to `users` keeps `no action` unless `set null` is stated.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table revisions (
      id uuid primary key default gen_random_uuid(),
      page_id uuid not null references pages (id) on delete cascade,
      title text not null,
      markdown text not null,
      markdown_hash bytea not null check (octet_length(markdown_hash) = 32),
      author_ids uuid[] not null default '{}',
      last_author_id uuid references users (id) on delete set null,
      reason text not null check (reason in ('idle', 'last_editor_left', 'before_restore', 'manual', 'import')),
      created_at timestamptz not null
    )`.execute(db);
  await sql`create index revisions_page_created_idx on revisions (page_id, created_at desc, id)`.execute(db);

  await sql`
    create table attachments (
      id uuid primary key default gen_random_uuid(),
      page_id uuid not null references pages (id) on delete cascade,
      uploader_id uuid references users (id) on delete set null,
      file_name text not null,
      content_type text not null,
      size bigint not null check (size > 0),
      s3_key text not null,
      status text not null check (status in ('pending', 'ready')),
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      ready_at timestamptz,
      deleted_at timestamptz
    )`.execute(db);
  await sql`create index attachments_page_id_idx on attachments (page_id)`.execute(db);
  await sql`create index attachments_pending_expires_idx on attachments (expires_at) where status = 'pending'`.execute(db);

  await sql`
    create table imports (
      id uuid primary key default gen_random_uuid(),
      created_by uuid references users (id) on delete set null,
      target_collection_id uuid not null references collections (id) on delete restrict,
      source text not null check (source in ('notion_md_csv', 'markdown_zip')),
      status text not null default 'created' check (status in ('created', 'uploaded', 'running', 'done', 'failed', 'cancelled')),
      s3_key text,
      bytes bigint,
      counts jsonb,
      error text,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    )`.execute(db);

  // `page_id` has no foreign key: the page may be purged or never created.
  await sql`
    create table import_items (
      id bigserial primary key,
      import_id uuid not null references imports (id) on delete cascade,
      path text not null,
      kind text not null check (kind in ('page', 'attachment', 'database_csv', 'other')),
      page_id uuid,
      url_id text,
      status text not null default 'pending' check (status in ('pending', 'ok', 'skipped', 'failed')),
      message text,
      markdown_bytes integer,
      state_bytes integer,
      attempts smallint not null default 0,
      detail jsonb,
      constraint import_items_import_path_uq unique (import_id, path)
    )`.execute(db);
  await sql`create index import_items_import_status_idx on import_items (import_id, status, id)`.execute(db);

  // `actor_id` has no foreign key: audit survives user removal.
  await sql`
    create table audit_events (
      id bigserial primary key,
      actor_id uuid,
      action text not null,
      target_type text,
      target_id text,
      detail jsonb,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`create index audit_events_created_idx on audit_events (created_at)`.execute(db);

  await sql`
    create table idempotency_keys (
      user_id uuid not null,
      key text not null,
      request_hash bytea not null,
      status integer,
      response jsonb,
      created_at timestamptz not null default now(),
      primary key (user_id, key)
    )`.execute(db);

  await sql`create index collection_access_group_id_idx on collection_access (group_id)`.execute(db);

  // Explicit least-privilege grants: no TRUNCATE, REFERENCES or TRIGGER. Cascades run with the owner's rights.
  await sql`grant select, insert on revisions, audit_events to grimoire_app`.execute(db);
  await sql`grant select, insert, update, delete on attachments, idempotency_keys to grimoire_app`.execute(db);
  await sql`grant select, insert, update on imports, import_items to grimoire_app`.execute(db);
  await sql`grant usage, select on sequence audit_events_id_seq, import_items_id_seq to grimoire_app`.execute(db);
}
