import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Semantic search keeps one vector for each chunk of a page (M7 contracts section 15.3). Raw SQL, as in 0001 to 0010. Forward-only.
//
// Needs the `vector` extension (pgvector). It is not a trusted extension, so the migration role cannot create it: the administrator makes it available before the
// first `grimoire migrate` (db/init/03-vector.sql locally; `grimoire db-setup` on a managed service, where the master user holds rds_superuser or its equivalent).
// Only the type and the `<=>` operator are used, which pgvector has had since 0.5: Amazon RDS for PostgreSQL 17 offers 0.8.0 from 17.3, 0.8.1 from 17.8 and 0.8.2 from 17.10.
//
// Both tables carry `tenant_id` with a composite key to the page, so a row can only sit in the tenant of its page, and no default: the writer names the tenant (decision 11).
// A trashed page keeps its rows; the foreign keys remove them when the page is purged. No ANN index: a search filters by tenant and by the readable collections first.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if not exists (select 1 from pg_extension where extname = 'vector') then
        raise exception 'the vector extension (pgvector) is not installed in this database: an administrator installs it before the migration, with "grimoire db-setup" on a managed service or by resetting the local database volume (db/init/03-vector.sql)';
      end if;
    end $$`.execute(db);

  await sql`
    create table page_chunks (
      page_id uuid not null,
      tenant_id text not null references tenants (id),
      chunk_index integer not null,
      model text not null,
      content_hash bytea not null check (octet_length(content_hash) = 32),
      char_start integer not null,
      char_end integer not null,
      token_count smallint not null,
      embedding vector not null,
      primary key (page_id, chunk_index),
      constraint page_chunks_page_tenant_fk foreign key (page_id, tenant_id) references pages (id, tenant_id) on delete cascade deferrable initially deferred
    )`.execute(db);
  await sql`create index page_chunks_model_idx on page_chunks (model)`.execute(db);
  await sql`create index page_chunks_tenant_idx on page_chunks (tenant_id)`.execute(db);

  await sql`
    create table page_embedding_state (
      page_id uuid primary key,
      tenant_id text not null references tenants (id),
      markdown_hash bytea not null check (octet_length(markdown_hash) = 32),
      model text not null,
      status text not null check (status in ('ready', 'failed')),
      chunk_count integer not null default 0,
      attempts smallint not null default 0,
      error text,
      embedded_at timestamptz,
      constraint page_embedding_state_page_tenant_fk foreign key (page_id, tenant_id) references pages (id, tenant_id) on delete cascade deferrable initially deferred
    )`.execute(db);
  await sql`create index page_embedding_state_status_idx on page_embedding_state (status, model)`.execute(db);
  await sql`create index page_embedding_state_tenant_idx on page_embedding_state (tenant_id)`.execute(db);

  // Explicit least-privilege grants, as in 0005: no TRUNCATE, REFERENCES or TRIGGER. Cascades run with the owner's rights.
  await sql`grant select, insert, update, delete on page_chunks, page_embedding_state to grimoire_app`.execute(db);
}
