import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Tenancy (docs/tenancy.md sections 3.1 and 5): the `tenants` table, `tenant_id` on every tenant table (every existing row is in the `legacy` tenant, and the column
// defaults to it so that the code of today, which names no tenant, keeps working: the migration that makes the server tenant-aware drops the defaults), the composite keys
// that keep a row in the tenant of its parents, and the per-tenant unique indexes. Raw SQL, as in 0001 to 0008.
// The composite keys are `deferrable initially deferred` so that `grimoire tenant-adopt` can move a workspace by explicit updates, in any order, checked at the commit.
const TENANT_TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages', 'revisions', 'attachments', 'audit_events', 'idempotency_keys', 'imports', 'import_items'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table tenants (
      id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
      name text not null check (char_length(name) between 1 and 255),
      domain text,
      created_at timestamptz not null default now()
    )`.execute(db);
  await sql`insert into tenants (id, name) values ('legacy', 'Legacy workspace')`.execute(db);
  for (const table of TENANT_TABLES) await sql`alter table ${sql.id(table)} add column tenant_id text not null default 'legacy' references tenants (id)`.execute(db);

  // What the composite keys point at.
  for (const table of ['users', 'groups', 'collections', 'pages', 'imports']) await sql`alter table ${sql.id(table)} add constraint ${sql.id(`${table}_id_tenant_uq`)} unique (id, tenant_id)`.execute(db);
  const sameTenant = async (table: string, name: string, column: string, parent: string): Promise<void> => {
    await sql`
      alter table ${sql.id(table)}
        add constraint ${sql.id(name)} foreign key (${sql.id(column)}, tenant_id) references ${sql.id(parent)} (id, tenant_id) deferrable initially deferred`.execute(db);
  };
  await sameTenant('group_members', 'group_members_group_tenant_fk', 'group_id', 'groups');
  await sameTenant('group_members', 'group_members_user_tenant_fk', 'user_id', 'users');
  await sameTenant('collection_access', 'collection_access_collection_tenant_fk', 'collection_id', 'collections');
  await sameTenant('collection_access', 'collection_access_user_tenant_fk', 'user_id', 'users');
  await sameTenant('collection_access', 'collection_access_group_tenant_fk', 'group_id', 'groups');
  await sameTenant('pages', 'pages_collection_tenant_fk', 'collection_id', 'collections');
  await sameTenant('revisions', 'revisions_page_tenant_fk', 'page_id', 'pages');
  await sameTenant('attachments', 'attachments_page_tenant_fk', 'page_id', 'pages');
  await sameTenant('imports', 'imports_collection_tenant_fk', 'target_collection_id', 'collections');
  await sameTenant('import_items', 'import_items_import_tenant_fk', 'import_id', 'imports');

  // Unique within a tenant, free across tenants: the global indexes of 0004 and 0006 become per tenant. The email and the provider's user id stay unique across the database
  // (a person has one row, in one tenant).
  await sql`alter table groups drop constraint groups_name_key`.execute(db);
  await sql`create unique index groups_tenant_name_uq on groups (tenant_id, name)`.execute(db);
  await sql`drop index collections_position_uq`.execute(db);
  await sql`create unique index collections_tenant_position_uq on collections (tenant_id, position) where deleted_at is null`.execute(db);

  await sql`create index users_tenant_idx on users (tenant_id)`.execute(db);
  await sql`create index pages_tenant_idx on pages (tenant_id)`.execute(db);
  await sql`create index audit_events_tenant_created_idx on audit_events (tenant_id, created_at)`.execute(db);

  // The runtime role reads tenants and adds the one of a person who is the first of a tenant to sign in; it never changes or removes one.
  await sql`grant select, insert on tenants to grimoire_app`.execute(db);
}
