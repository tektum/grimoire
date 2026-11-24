import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertTenantRows, insertUser, TENANT_TABLES } from '@tektum/grimoire-test-support/database';
import { adoptTenant } from '../../src/tenant-adopt.js';
import { addTenant, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// `grimoire tenant-adopt` (docs/tenancy.md section 5, item 4), as the migrator: one database for the whole file, its tests run in order.
let t: TestDatabase;
const run = (statement: string) => t.admin.query(statement);
const NEW = { name: 'Acme', domain: 'acme.example' };

/** Every row of every tenant table counted by tenant, and the tenants: equal before and after a refusal. */
async function snapshot(): Promise<unknown> {
  const counts = await Promise.all(TENANT_TABLES.map((table) => t.admin.query(`select '${table}' as t, tenant_id, count(*)::int as n from ${table} group by tenant_id order by tenant_id`)));
  return { counts: counts.flat(), tenants: await t.admin.query(`select id, name, domain from tenants order by id`) };
}
async function inTenant(tenantId: string): Promise<Record<string, number>> {
  const counts = await Promise.all(TENANT_TABLES.map(async (table) => [table, (await t.admin.query<{ n: number }>(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantId]))[0]!.n] as const));
  return Object.fromEntries(counts);
}

beforeAll(async () => {
  t = await createTestDatabase('adopt');
  await insertTenantRows(run, 'legacy');
  await insertTenantRows(run, 'legacy');
  await addTenant(t.admin, 'busy');
  await addTenant(t.admin, 'early');
  await addTenant(t.admin, 'vacant');
  await insertUser(run, { tenant_id: 'busy' });
  await insertUser(run, { tenant_id: 'early' });
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('tenant-adopt refuses, and changes nothing', () => {
  it.each([
    ['bad-tenant-id', { from: 'legacy', to: 'no spaces' }],
    ['bad-tenant-id', { from: 'legacy', to: 'x'.repeat(129) }],
    ['bad-tenant-id', { from: '', to: 'acme' }],
    ['same-tenant', { from: 'legacy', to: 'legacy' }],
    ['source-unknown', { from: 'nobody', to: 'acme', ...NEW }],
    ['source-empty', { from: 'vacant', to: 'acme', ...NEW }],
    ['target-unnamed', { from: 'legacy', to: 'acme' }],
    ['target-unnamed', { from: 'legacy', to: 'acme', name: 'Acme' }],
    ['target-unnamed', { from: 'legacy', to: 'acme', domain: 'acme.example' }],
  ])('%s: %j', async (reason, request) => {
    const before = await snapshot();
    expect(await adoptTenant(t.admin, request)).toEqual({ kind: 'refused', reason });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['groups', 'audit_events'])('target-not-empty: the target holds a row in %s', async (table) => {
    await run(table === 'groups' ? `insert into groups (name, tenant_id) values ('Busy', 'busy')` : `insert into audit_events (action, tenant_id) values ('test', 'busy')`);
    const before = await snapshot();
    expect(await adoptTenant(t.admin, { from: 'legacy', to: 'busy' })).toEqual({ kind: 'refused', reason: 'target-not-empty' });
    expect(await snapshot()).toEqual(before);
    await run(`delete from ${table} where tenant_id = 'busy'`);
  });
});

describe('tenant-adopt into a new tenant', () => {
  it('moves every row of every table in one go, makes the tenant from its name and domain, and keeps the legacy row', async () => {
    const legacy = await inTenant('legacy');
    const users = (await t.admin.query<{ n: number }>(`select count(*)::int as n from users`))[0]!.n;
    expect(Object.values(legacy).every((n) => n > 0), JSON.stringify(legacy)).toBe(true);

    expect(await adoptTenant(t.admin, { from: 'legacy', to: 'acme', ...NEW })).toEqual({ kind: 'done', tenantCreated: true, moved: legacy });

    expect(await inTenant('acme')).toEqual(legacy);
    expect(Object.values(await inTenant('legacy')).every((n) => n === 0)).toBe(true);
    expect(await t.admin.query(`select id, name, domain from tenants where id in ('acme', 'legacy') order by id`)).toEqual([
      { id: 'acme', ...NEW }, { id: 'legacy', name: 'Legacy workspace', domain: null },
    ]);
    expect(await t.admin.query(`select count(*)::int as n, count(distinct descope_user_id)::int as people from users`)).toEqual([{ n: users, people: users }]);
  });

  it('a second run finds the source empty and changes nothing', async () => {
    const before = await snapshot();
    expect(await adoptTenant(t.admin, { from: 'legacy', to: 'acme', ...NEW })).toEqual({ kind: 'refused', reason: 'source-empty' });
    expect(await snapshot()).toEqual(before);
  });

  it('the composite keys hold after the move: a child cannot be put back in the old tenant alone', async () => {
    await expect(run(`update pages set tenant_id = 'legacy' where tenant_id = 'acme'`)).rejects.toMatchObject({ code: '23503' });
  });
});

describe('tenant-adopt into a tenant that already exists', () => {
  it('moves into a tenant that holds only people (made at a first sign-in) and leaves its name alone', async () => {
    const acme = await inTenant('acme');
    const early = await inTenant('early');
    const result = await adoptTenant(t.admin, { from: 'acme', to: 'early', name: 'Ignored', domain: 'ignored.example' });
    expect(result).toEqual({ kind: 'done', tenantCreated: false, moved: acme });
    expect(await inTenant('early')).toEqual(Object.fromEntries(TENANT_TABLES.map((table) => [table, acme[table]! + early[table]!])));
    expect(await t.admin.query(`select name, domain from tenants where id = 'early'`)).toEqual([{ name: 'early', domain: 'early' }]);
  });
});
