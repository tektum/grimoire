import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { KyselyDatabase } from './index.js';

/**
 * The tables that carry `tenant_id`, as the database says (the base tables of the public schema with that column, but `tenants` itself): a table a later migration gives a tenant is moved
 * too, with no list to keep in step. One left behind would fail its composite keys at the commit. Names are checked before they are put into a statement.
 */
async function tenantTables(tx: Queryable): Promise<readonly string[]> {
  const rows = await tx.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'tenant_id' and x.table_type = 'BASE TABLE' and c.table_name <> 'tenants' order by c.table_name`,
  );
  const names = rows.map((r) => r.table_name);
  const bad = names.find((name) => !/^[a-z_][a-z0-9_]*$/.test(name));
  if (bad !== undefined) throw new Error('a tenant table has a name this command will not put into a statement');
  return names;
}
/** The shape the `tenants` table checks. */
const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface TenantAdoptRequest { readonly from: string; readonly to: string; readonly name?: string; readonly domain?: string }
export type TenantAdoptRefusal = 'bad-tenant-id' | 'same-tenant' | 'source-unknown' | 'source-empty' | 'target-unnamed' | 'target-not-empty';
export type TenantAdoptResult =
  | { readonly kind: 'done'; readonly tenantCreated: boolean; readonly moved: Readonly<Record<string, number>> }
  | { readonly kind: 'refused'; readonly reason: TenantAdoptRefusal };

async function holdsRows(tx: Queryable, tables: readonly string[], tenantId: string): Promise<boolean> {
  const [row] = await tx.query<{ held: boolean }>(`select ${tables.map((table) => `exists (select 1 from ${table} where tenant_id = $1)`).join(' or ')} as held`, [tenantId]) as readonly [{ held: boolean }]; // a select without `from`: one row
  return row.held;
}

/**
 * `grimoire tenant-adopt` (docs/tenancy.md section 5, item 4), as the migrator: moves every row of the `from` tenant into the `to` tenant in one transaction, by one update
 * of `tenant_id` for each tenant table (found in the database); the composite keys are deferred, so they are checked at the commit. The `to` row of `tenants` is used when it exists and made from
 * the name and domain when it does not. Refuses, before any change, when the target holds a row in a table other than `users` (the per-tenant unique indexes could collide)
 * or the source holds none. The `from` row of `tenants` is kept: the column defaults of 0009 still name `legacy`.
 */
export async function adoptTenant(db: KyselyDatabase, request: TenantAdoptRequest): Promise<TenantAdoptResult> {
  const { from, to, name, domain } = request;
  if (!TENANT_ID.test(from) || !TENANT_ID.test(to)) return { kind: 'refused', reason: 'bad-tenant-id' };
  if (from === to) return { kind: 'refused', reason: 'same-tenant' };
  return db.transaction(async (tx): Promise<TenantAdoptResult> => {
    // No other writer may add a row to either tenant, or the target's row to `tenants`, between the checks and the commit; readers carry on.
    const tables = await tenantTables(tx);
    await tx.query(`lock table tenants, ${tables.join(', ')} in exclusive mode`);
    const tenants = await tx.query<{ id: string }>(`select id from tenants where id in ($1, $2)`, [from, to]);
    if (!tenants.some((row) => row.id === from)) return { kind: 'refused', reason: 'source-unknown' };
    if (!(await holdsRows(tx, tables, from))) return { kind: 'refused', reason: 'source-empty' };
    const tenantCreated = !tenants.some((row) => row.id === to);
    if (tenantCreated) {
      if (name === undefined || domain === undefined) return { kind: 'refused', reason: 'target-unnamed' };
      await tx.query(`insert into tenants (id, name, domain) values ($1, $2, $3)`, [to, name, domain]);
    } else if (await holdsRows(tx, tables.filter((table) => table !== 'users'), to)) {
      return { kind: 'refused', reason: 'target-not-empty' };
    }
    const moved: Record<string, number> = {};
    for (const table of tables) {
      const [count] = await tx.query<{ n: number }>(`with moved as (update ${table} set tenant_id = $2 where tenant_id = $1 returning 1) select count(*)::int as n from moved`, [from, to]) as readonly [{ n: number }]; // an aggregate without `group by`: one row
      moved[table] = count.n;
    }
    return { kind: 'done', tenantCreated, moved };
  });
}
