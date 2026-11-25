import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Row-level security (docs/tenancy.md section 3.2, step 4): the backstop under the explicit tenant scoping. On every table that carries `tenant_id` the runtime role `grimoire_app` sees and writes
// only the rows of the tenant its transaction set (`set local app.tenant`), and the operator role `grimoire_ops` (a member of `grimoire_app`, without `BYPASSRLS`, which a managed database's master
// user cannot give) has a policy of its own that passes every row. Row-level security is enabled, not forced: the migrator role owns the tables and is not subject to the policies.
// The predicate is the plain comparison with a stable setting, with no function of the row, so a scan pays nothing per row and an index on `tenant_id` can serve it; the second argument and the
// `nullif` make a connection that never set the value, and a reused one where an earlier transaction did, see no rows instead of failing. Raw SQL, as in 0001 to 0013. Forward-only.
// The list is written out: a later migration that adds a tenant table adds its policies in the same migration (a test fails for a tenant table without them).
const TENANT_TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages', 'revisions', 'attachments', 'audit_events', 'idempotency_keys', 'imports', 'import_items', 'page_chunks', 'page_embedding_state'] as const;
/** Tables whose `tenant_id` no index led with (the others have `users_tenant_idx`, `pages_tenant_idx`, `audit_events_tenant_created_idx`, the per-tenant unique indexes of 0009 and the two of 0011). */
const WITHOUT_TENANT_INDEX = ['group_members', 'collection_access', 'revisions', 'attachments', 'idempotency_keys', 'imports', 'import_items'] as const;
const TENANT = sql.raw(`nullif(current_setting('app.tenant', true), '')`);

export async function up(db: Kysely<unknown>): Promise<void> {
  // The policies name the operator role, which `grimoire db-setup` makes before the first migration: say so, instead of PostgreSQL's "role does not exist" halfway.
  const roles = await sql<{ rolname: string }>`select rolname from pg_roles where rolname in ('grimoire_app', 'grimoire_ops')`.execute(db);
  if (roles.rows.length !== 2) throw new Error('the roles grimoire_app and grimoire_ops must exist before this migration: run "grimoire db-setup" first');

  for (const table of WITHOUT_TENANT_INDEX) await sql`create index if not exists ${sql.id(`${table}_tenant_idx`)} on ${sql.id(table)} (tenant_id)`.execute(db);

  for (const table of TENANT_TABLES) {
    await sql`alter table ${sql.id(table)} enable row level security`.execute(db);
    await sql`create policy tenant_isolation on ${sql.id(table)} for all to grimoire_app using (tenant_id = ${TENANT}) with check (tenant_id = ${TENANT})`.execute(db);
    await sql`create policy operator_all on ${sql.id(table)} for all to grimoire_ops using (true) with check (true)`.execute(db);
  }

  // The tenants table has no `tenant_id`: its key is the tenant. The runtime role reads its own tenant's row and nothing else; a tenant is made (a first sign-in) or changed by the operator role.
  await sql`alter table tenants enable row level security`.execute(db);
  await sql`create policy tenants_self on tenants for select to grimoire_app using (id = ${TENANT})`.execute(db);
  await sql`create policy operator_all on tenants for all to grimoire_ops using (true) with check (true)`.execute(db);
}
