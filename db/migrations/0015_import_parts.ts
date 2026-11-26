import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// The parts of an import (a big Notion export is uploaded as several zips, each sent to the store in parts of its own): one row for each zip, with its key, its size and, while a
// multipart upload of it is open, the upload's id. Every import has at least one: the rows `imports` already has are copied here, and `imports.s3_key` and `imports.bytes`
// stay, written by the code of today, until a later migration drops them once nothing reads them. A tenant table, so it carries the composite key and the policies of 0009 and 0014
// (a test fails for a tenant table without them).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table import_parts (
      tenant_id text not null references tenants (id),
      import_id uuid not null,
      ordinal smallint not null check (ordinal >= 0),
      s3_key text not null,
      bytes bigint not null check (bytes >= 0),
      upload_id text,
      primary key (import_id, ordinal),
      constraint import_parts_import_tenant_fk foreign key (import_id, tenant_id) references imports (id, tenant_id) on delete cascade deferrable initially deferred
    )`.execute(db);
  await sql`create index import_parts_tenant_idx on import_parts (tenant_id)`.execute(db);
  await sql`grant select, insert, update on import_parts to grimoire_app`.execute(db);

  const tenant = sql.raw(`nullif(current_setting('app.tenant', true), '')`);
  await sql`alter table import_parts enable row level security`.execute(db);
  await sql`create policy tenant_isolation on import_parts for all to grimoire_app using (tenant_id = ${tenant}) with check (tenant_id = ${tenant})`.execute(db);
  await sql`create policy operator_all on import_parts for all to grimoire_ops using (true) with check (true)`.execute(db);

  // Last: the rows bring deferred foreign-key checks, and PostgreSQL refuses a change to the table's definition while they are pending.
  await sql`insert into import_parts (tenant_id, import_id, ordinal, s3_key, bytes) select tenant_id, id, 0, s3_key, coalesce(bytes, 0) from imports where s3_key is not null`.execute(db);
}
