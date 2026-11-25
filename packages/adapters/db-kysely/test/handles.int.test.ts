import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, opsUrl } from '@tektum/grimoire-test-support/database';
import { createDatabase, createOpsDatabase, scoped } from '../src/index.js';
import type { KyselyDatabase, OperatorDatabase } from '../src/index.js';
import { createTestDatabase } from './collections/support.js';
import type { TestDatabase } from './collections/support.js';

// docs/tenancy.md section 3.2, step 1: the handles the row-level security will need, with the real roles of the development database. No policy exists yet.
const TENANT = `select nullif(current_setting('app.tenant', true), '') as tenant`;
let t: TestDatabase;
let one: KyselyDatabase; // a pool of one connection: every statement below runs on the same session
let ops: OperatorDatabase;

beforeAll(async () => {
  t = await createTestDatabase('handles');
  one = createDatabase(appUrl(t.name), { maxConnections: 1 });
  ops = createOpsDatabase(opsUrl(t.name));
}, 120_000);
afterAll(async () => {
  await ops.close();
  await one.close();
  await t.drop();
});

describe('scoped(db, tenant)', () => {
  it('sets the tenant for its own statement, and the next statement on the same connection has none', async () => {
    expect(await one.query(TENANT)).toEqual([{ tenant: null }]);
    expect(await scoped(one, 'tenant-a').query(TENANT)).toEqual([{ tenant: 'tenant-a' }]);
    expect(await one.query(TENANT)).toEqual([{ tenant: null }]);
    expect(await scoped(one, 'tenant-b').query(TENANT)).toEqual([{ tenant: 'tenant-b' }]);
    expect(await one.query(`select current_setting('app.tenant', true) as raw`)).toEqual([{ raw: '' }]); // what nullif turns into null
  });

  it('passes the statement\'s parameters', async () => {
    expect(await scoped(one, 'tenant-a').query(`select $1::int as n, nullif(current_setting('app.tenant', true), '') as tenant`, [7])).toEqual([{ n: 7, tenant: 'tenant-a' }]);
  });

  it('sets the tenant at the start of a transaction, for every statement in it, and clears it after', async () => {
    const seen = await scoped(one, 'tenant-c').transaction(async (tx) => [...(await tx.query(TENANT)), ...(await tx.query(TENANT))]);
    expect(seen).toEqual([{ tenant: 'tenant-c' }, { tenant: 'tenant-c' }]);
    expect(await one.query(TENANT)).toEqual([{ tenant: null }]);
  });

  it('rolls back on an error, and leaves the connection clean for the next statement', async () => {
    const failing = scoped(one, 'tenant-d').transaction(async (tx) => {
      await tx.query(`insert into tenants (id, name, domain) values ('rolled-back', 'r', 'r.example')`);
      await tx.query('select 1 / 0');
    });
    await expect(failing).rejects.toThrow(/division by zero/);
    await expect(scoped(one, 'tenant-d').query('select 1 / 0')).rejects.toThrow(/division by zero/);
    expect(await one.query(`select count(*)::int as n from tenants where id = 'rolled-back'`)).toEqual([{ n: 0 }]);
    expect(await one.query(TENANT)).toEqual([{ tenant: null }]);
  });

  it('commits what it wrote', async () => {
    await scoped(one, 'tenant-e').query(`insert into tenants (id, name, domain) values ('committed', 'c', 'c.example')`);
    expect(await one.query(`select count(*)::int as n from tenants where id = 'committed'`)).toEqual([{ n: 1 }]);
  });

  it('lets a transaction raise its isolation level as its first statement, with the tenant still set', async () => {
    const seen = await scoped(one, 'tenant-f').transaction(async (tx) => {
      await tx.query('set transaction isolation level serializable');
      return tx.query(`select current_setting('transaction_isolation') as isolation, nullif(current_setting('app.tenant', true), '') as tenant`);
    });
    expect(seen).toEqual([{ isolation: 'serializable', tenant: 'tenant-f' }]);
    expect(await one.query(TENANT)).toEqual([{ tenant: null }]);
  });
});

describe('createOpsDatabase(url): the operator role grimoire_ops', () => {
  it('connects as grimoire_ops, which does not bypass row-level security by itself', async () => {
    expect(await ops.transaction((tx) => tx.query(`select current_user as who, rolbypassrls as bypass from pg_roles where rolname = current_user`))).toEqual([{ who: 'grimoire_ops', bypass: false }]);
  });

  it('has the runtime role\'s grants and no more: it reads a tenant table, and cannot create or alter one', async () => {
    expect(await ops.transaction((tx) => tx.query(`select count(*)::int as n from pages`))).toEqual([{ n: 0 }]);
    await expect(ops.transaction((tx) => tx.query('create table mine (id int)'))).rejects.toThrow(/permission denied/);
    await expect(ops.transaction((tx) => tx.query('alter table pages add column x int'))).rejects.toThrow(/must be owner/);
    await expect(ops.transaction((tx) => tx.query('set role grimoire_migrator'))).rejects.toThrow(/permission denied to set role/);
  });

  it('is a small pool of its own: at most 4 connections by default', async () => {
    const pids = await Promise.all(Array.from({ length: 8 }, () => ops.transaction(async (tx) => {
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid, pg_sleep(0.05)');
      return row?.pid;
    })));
    expect(new Set(pids).size).toBeLessThanOrEqual(4);
  });
});
