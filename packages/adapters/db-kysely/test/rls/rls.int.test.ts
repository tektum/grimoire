import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, insertTenantRows, TENANT_TABLES } from '@tektum/grimoire-test-support/database';
import { createDatabase, scoped } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// docs/tenancy.md section 3.2, step 4: row-level security on every tenant table. The runtime role `grimoire_app` sees and writes only the rows of the tenant its transaction set
// (`set local app.tenant`), the operator role `grimoire_ops` sees every row, the migrator role owns the tables and is not subject to the policies (the policies are enabled, not forced).
const A = 'tenant-a';
const B = 'tenant-b';
const POLICY = `(tenant_id = NULLIF(current_setting('app.tenant'::text, true), ''::text))`;

let t: TestDatabase;
let one: KyselyDatabase; // the runtime role on a pool of one connection: whatever a transaction leaves on it, the next one finds
const count = async (db: Pick<KyselyDatabase, 'query'>, table: string, where = 'true'): Promise<number> => Number((await db.query<{ n: string }>(`select count(*) as n from ${table} where ${where}`))[0]?.n);
/** The code of the error a statement raises, or undefined when it ran. */
const refused = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try { await run(); return undefined; } catch (error) { return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error); }
};
/** The tenant tables that have no policy for each role, found the way the migration finds them: every ordinary table of the schema with a `tenant_id` column. */
async function unpoliced(admin: KyselyDatabase): Promise<string[]> {
  const rows = await admin.query<{ name: string; secured: boolean; policies: string[] }>(
    `select c.relname as name, c.relrowsecurity as secured,
            coalesce((select array_agg(p.polname order by p.polname) from pg_policy p where p.polrelid = c.oid), '{}') as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by 1`,
  );
  return rows.filter((r) => !r.secured || !r.policies.includes('operator_all') || !(r.policies.includes('tenant_isolation') || r.policies.includes('tenants_self'))).map((r) => r.name);
}

beforeAll(async () => {
  t = await createTestDatabase('rls');
  one = createDatabase(appUrl(t.name), { maxConnections: 1 });
  await t.admin.query(`insert into tenants (id, name) values ('${A}', 'A'), ('${B}', 'B')`);
  const run = (statement: string) => t.admin.query(statement);
  await insertTenantRows(run, A);
  await insertTenantRows(run, A);
  await insertTenantRows(run, B);
}, 60_000);
afterAll(async () => {
  await one.close();
  await t.drop();
});

describe('which tables are policed', () => {
  it('every table with a tenant_id has row-level security enabled (not forced), a policy for the runtime role and one for the operator role, and the list is the one the tests know', async () => {
    expect(await unpoliced(t.admin)).toEqual([]);
    const tables = await t.admin.query<{ name: string }>(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1`);
    expect(tables.map((r) => r.name)).toEqual([...TENANT_TABLES, 'tenants'].sort());
    expect(await t.admin.query(`select relname from pg_class where relforcerowsecurity and relkind = 'r'`)).toEqual([]);
    for (const table of TENANT_TABLES) {
      const policies = await t.admin.query<{ polname: string; roles: string[]; using: string; check: string | null }>(
        `select p.polname, array(select rolname::text from pg_roles r where r.oid = any(p.polroles)) as roles, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
           from pg_policy p where p.polrelid = '${table}'::regclass order by 1`,
      );
      expect(policies, table).toEqual([
        { polname: 'operator_all', roles: ['grimoire_ops'], using: 'true', check: 'true' },
        { polname: 'tenant_isolation', roles: ['grimoire_app'], using: POLICY, check: POLICY },
      ]);
    }
  });

  it('a tenant table that has no policy is found: the enumeration fails for it, by name', async () => {
    await t.admin.query(`create table zz_unpoliced (id int primary key, tenant_id text not null)`);
    try {
      expect(await unpoliced(t.admin)).toEqual(['zz_unpoliced']);
      await t.admin.query(`alter table zz_unpoliced enable row level security`);
      expect(await unpoliced(t.admin), 'enabled but without policies is still unpoliced').toEqual(['zz_unpoliced']);
    } finally {
      await t.admin.query(`drop table zz_unpoliced`);
    }
    expect(await unpoliced(t.admin)).toEqual([]);
  });

  it('adds a tenant_id index to the tables that had none to lead with', async () => {
    const indexes = await t.admin.query<{ indexname: string }>(`select indexname from pg_indexes where schemaname = 'public' and indexname like '%\\_tenant\\_idx' order by 1`);
    expect(indexes.map((i) => i.indexname)).toEqual(expect.arrayContaining(['attachments_tenant_idx', 'collection_access_tenant_idx', 'group_members_tenant_idx', 'idempotency_keys_tenant_idx', 'import_items_tenant_idx', 'imports_tenant_idx', 'revisions_tenant_idx']));
  });
});

describe('the runtime role sees the rows of its tenant and nothing else', () => {
  it.each(TENANT_TABLES.map((table) => [table]))('%s: each tenant sees its own rows only, no tenant and an empty tenant see none, the operator sees all, the migrator sees all', async (table) => {
    const own: Record<string, number> = { [A]: await count(t.admin, table, `tenant_id = '${A}'`), [B]: await count(t.admin, table, `tenant_id = '${B}'`) };
    expect(own[A], 'A has two sets of rows').toBeGreaterThan(own[B] ?? 0);
    expect(own[B]).toBeGreaterThan(0);
    for (const tenant of [A, B]) {
      const seen = await scoped(t.app, tenant).transaction((tx) => tx.query<{ tenant_id: string }>(`select distinct tenant_id from ${table}`));
      expect(seen.map((r) => r.tenant_id), `${table} as ${tenant}`).toEqual([tenant]);
      expect(await count(scoped(t.app, tenant), table), `${table} as ${tenant}`).toBe(own[tenant]);
    }
    expect(await count(t.app, table), 'no tenant set').toBe(0);
    expect(await t.app.transaction(async (tx) => { await tx.query(`set local app.tenant = ''`); return count(tx, table); }), 'an empty tenant').toBe(0);
    const all = await count(t.admin, table); // the migrator owns the table and is not subject to the policies: every row, of the two tenants and of the others (the legacy one holds the system rows)
    expect(all).toBeGreaterThanOrEqual((own[A] ?? 0) + (own[B] ?? 0));
    expect(await t.ops.transaction((tx) => count(tx, table)), 'the operator sees every row').toBe(all);
  });

  it('the tenants table: a tenant sees its own row, nothing else sees any, and only the operator may add or change one', async () => {
    expect((await scoped(t.app, A).query<{ id: string }>(`select id from tenants`)).map((r) => r.id)).toEqual([A]);
    expect(await count(t.app, 'tenants'), 'no tenant set').toBe(0);
    expect(await t.ops.transaction((tx) => count(tx, 'tenants')), 'the operator sees every tenant').toBe(await count(t.admin, 'tenants'));
    expect(await refused(() => scoped(t.app, A).query(`insert into tenants (id, name) values ('${A}-new', 'new')`)), 'the runtime role does not add tenants').toBe('42501');
    expect(await refused(() => scoped(t.app, A).query(`update tenants set name = 'renamed' where id = '${A}'`)), 'nor change them (no UPDATE grant)').toBe('42501');
    await t.ops.transaction((tx) => tx.query(`insert into tenants (id, name) values ('ops-made', 'ops-made')`));
    expect(await count(t.admin, 'tenants', `id = 'ops-made'`)).toBe(1);
    await t.admin.query(`delete from tenants where id = 'ops-made'`);
  });
});

describe('a write is refused or does nothing outside the tenant', () => {
  it.each(TENANT_TABLES.map((table) => [table]))('%s: another tenant\'s rows cannot be changed or deleted, and a row cannot be moved into another tenant', async (table) => {
    // Some tables are append-only for the runtime role (no UPDATE or DELETE grant: the privilege error comes before the policy); the policy is tested where the role may write.
    const may = async (privilege: string) => (await t.admin.query<{ ok: boolean }>(`select has_table_privilege('grimoire_app', '${table}', '${privilege}') as ok`))[0]?.ok === true;
    const other = await count(t.admin, table, `tenant_id = '${B}'`);
    if (await may('UPDATE')) {
      const changed = await scoped(t.app, A).transaction((tx) => tx.query<{ n: string }>(`with u as (update ${table} set tenant_id = tenant_id where tenant_id = '${B}' returning 1) select count(*) as n from u`));
      expect(Number(changed[0]?.n), 'an update of the other tenant\'s rows touches none').toBe(0);
      expect(await refused(() => scoped(t.app, A).query(`update ${table} set tenant_id = '${B}' where tenant_id = '${A}'`)), 'a row cannot be given to another tenant').toBe('42501');
    }
    if (await may('DELETE')) {
      const deleted = await scoped(t.app, A).transaction((tx) => tx.query<{ n: string }>(`with d as (delete from ${table} where tenant_id = '${B}' returning 1) select count(*) as n from d`));
      expect(Number(deleted[0]?.n), 'a delete of the other tenant\'s rows removes none').toBe(0);
    }
    expect(await count(t.admin, table, `tenant_id = '${B}'`)).toBe(other);
  });
  it('an insert that names another tenant is refused, and one with no tenant set is refused', async () => {
    const row = (tenant: string) => `insert into groups (name, tenant_id) values ('g-${Math.random()}', '${tenant}')`;
    expect(await refused(() => scoped(t.app, A).query(row(B)))).toBe('42501');
    expect(await refused(() => t.app.query(row(A))), 'no tenant set').toBe('42501');
    expect(await refused(() => scoped(t.app, A).query(row(A)))).toBeUndefined();
    await t.admin.query(`delete from groups where name like 'g-%'`);
  });
});

describe('what a connection carries from one transaction to the next, and what the runtime role may not do', () => {
  it('the tenant is local to the transaction: the next transaction on the same connection has none and sees no rows', async () => {
    expect(await count(scoped(one, A), 'pages')).toBeGreaterThan(0);
    const carried = await one.query<{ tenant: string | null }>(`select current_setting('app.tenant', true) as tenant`);
    expect(['', null]).toContain(carried[0]?.tenant);
    expect(await count(one, 'pages'), 'the same connection, no tenant set').toBe(0);
    expect(await count(scoped(one, B), 'pages'), 'and the next tenant sees its own').toBe(await count(t.admin, 'pages', `tenant_id = '${B}'`));
  });

  it('a rolled-back transaction leaves no tenant behind either', async () => {
    await refused(() => scoped(one, A).transaction(async (tx) => { await tx.query(`select 1`); throw new Error('rolled back'); }));
    expect(await count(one, 'pages')).toBe(0);
  });

  it('the runtime role cannot switch the policies off, change them or step around them', async () => {
    expect(await refused(() => t.app.query(`alter table pages disable row level security`))).toBe('42501');
    expect(await refused(() => t.app.query(`drop policy tenant_isolation on pages`))).toBe('42501');
    expect(await refused(() => t.app.query(`create policy anyone on pages using (true)`))).toBe('42501');
    expect(await refused(() => t.app.query(`alter table pages force row level security`))).toBe('42501');
    // With `row_security` off a statement that a policy would limit does not run unlimited: it fails.
    expect(await refused(() => t.app.transaction(async (tx) => { await tx.query(`set local row_security = off`); await tx.query(`select 1 from pages limit 1`); }))).toBe('42501');
  });
});

describe('the policies keep the indexes in use', () => {
  const plan = async (statement: string): Promise<string> => (await scoped(t.app, A).transaction(async (tx) => {
    await tx.query(`set local enable_seqscan = off`);
    return tx.query<{ 'QUERY PLAN': string }>(`explain ${statement}`);
  })).map((r) => r['QUERY PLAN']).join('\n');

  it('a read of a tenant table with no other filter goes through the tenant index, and one by key through the key\'s own', async () => {
    expect(await plan(`select id from pages`)).toMatch(/pages_tenant_idx/);
    expect(await plan(`select page_id from page_chunks`)).toMatch(/page_chunks_tenant_idx/);
    expect(await plan(`select id from pages where id = '00000000-0000-4000-8000-000000000002'`)).toMatch(/Index (Only )?Scan using pages_/);
  });
});
