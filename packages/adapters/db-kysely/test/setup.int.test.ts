import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, setupDatabase } from '../src/index.js';
import type { DatabaseRoles } from '../src/index.js';

// Its own database and its own role names, created and dropped by this file: the roles of the shared development database are cluster-wide and must keep their passwords.
const ID = String(process.pid);
const DATABASE = `grimoire_dbsetup_${ID}`;
const ROLES: DatabaseRoles = { app: `t_app_${ID}`, migrator: `t_migrator_${ID}`, ops: `t_ops_${ID}` };
const MANAGED_ADMIN = `t_admin_${ID}`; // a master user of a managed service: it can create roles, but it is not a superuser
const server = '127.0.0.1:55432';
const url = (role: string, password: string, name: string): string => `postgresql://${role}:${password}@${server}/${name}`;

async function run<T>(connection: string, work: (query: (text: string, params?: readonly unknown[]) => Promise<readonly unknown[]>) => Promise<T>): Promise<T> {
  const handle = createDatabase(connection, { maxConnections: 1 });
  try { return await work((text, params) => handle.query(text, params)); } finally { await handle.close(); }
}
const asSuperuser = <T>(name: string, work: Parameters<typeof run<T>>[1]) => run(url('grimoire_admin', 'grimoire-dev', name), work);
const canConnect = (role: string, password: string): Promise<boolean> => run(url(role, password, DATABASE), (q) => q('select 1')).then(() => true, () => false);
type Passwords = { app: string; migrator: string; ops: string };
const setup = <T>(as: { role: string; password: string }, passwords: Passwords, work?: (r: Awaited<ReturnType<typeof setupDatabase>>) => T) => {
  const handle = createDatabase(url(as.role, as.password, DATABASE), { maxConnections: 1 });
  return setupDatabase(handle, passwords, ROLES).finally(() => handle.close()).then((r) => (work ? work(r) : r));
};
const SUPER = { role: 'grimoire_admin', password: 'grimoire-dev' };
const PASSWORDS = { app: 'app-password-0123456789', migrator: 'migrator-password-0123456789', ops: 'ops-password-0123456789' };
const ROTATED = { app: 'rotated-app-password-0123456789', migrator: 'rotated-migrator-password-0123456789', ops: 'rotated-ops-password-0123456789' };

beforeAll(async () => {
  await asSuperuser('postgres', (q) => q(`drop database if exists ${DATABASE} with (force)`));
  await asSuperuser('postgres', (q) => q(`create database ${DATABASE}`));
}, 60_000);
afterAll(async () => {
  await asSuperuser('postgres', async (q) => {
    await q(`drop database if exists ${DATABASE} with (force)`);
    for (const role of [ROLES.ops, ROLES.app, ROLES.migrator, MANAGED_ADMIN]) await q(`drop role if exists ${role}`);
  });
});

describe('setupDatabase against a PostgreSQL superuser', () => {
  it('creates the three roles, locks the database to them, hands the schemas to the migration role and installs citext and pg_trgm', async () => {
    const first = await setup(SUPER, PASSWORDS);
    expect(first).toEqual({ created: [ROLES.migrator, ROLES.app, ROLES.ops], updated: [] });
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(true);
    expect(await canConnect(ROLES.migrator, PASSWORDS.migrator)).toBe(true);
    expect(await canConnect(ROLES.ops, PASSWORDS.ops)).toBe(true);
    expect(await canConnect(ROLES.app, 'not-the-password-0123456789')).toBe(false);
    const state = await asSuperuser(DATABASE, async (q) => ({
      owners: await q(`select n.nspname as schema, r.rolname as owner from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname in ('public', 'pgboss') order by 1`),
      acl: await q('select datacl::text as acl from pg_database where datname = current_database()'),
      appCan: await q(`select has_schema_privilege($1, 'public', 'usage') as usage, has_schema_privilege($1, 'public', 'create') as make, has_schema_privilege($1, 'pgboss', 'usage') as boss`, [ROLES.app]),
      citext: await q(`select 1 from pg_extension where extname = 'citext'`),
      trgm: await q(`select 1 from pg_extension where extname = 'pg_trgm'`),
    }));
    expect(state.owners).toEqual([{ schema: 'pgboss', owner: ROLES.migrator }, { schema: 'public', owner: ROLES.migrator }]);
    expect(String((state.acl[0] as { acl: string }).acl)).not.toMatch(/(^\{|,)=/); // no entry for PUBLIC
    expect(state.appCan).toEqual([{ usage: true, make: false, boss: false }]); // the runtime role gets the job queue's grants from `grimoire migrate`, not here
    expect(state.citext).toHaveLength(1);
    expect(state.trgm).toHaveLength(1);
  });

  it('is safe to run again, and a run with new passwords rotates them', async () => {
    const rotated = ROTATED;
    expect(await setup(SUPER, rotated)).toEqual({ created: [], updated: [ROLES.migrator, ROLES.app, ROLES.ops] });
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(false);
    expect(await canConnect(ROLES.app, rotated.app)).toBe(true);
    expect(await canConnect(ROLES.migrator, rotated.migrator)).toBe(true);
    expect(await canConnect(ROLES.ops, rotated.ops)).toBe(true);
    expect(await canConnect(ROLES.ops, PASSWORDS.ops)).toBe(false);
    expect(await setup(SUPER, rotated)).toEqual({ created: [], updated: [ROLES.migrator, ROLES.app, ROLES.ops] }); // again, nothing changes and nothing fails
  });

  it('quotes a password with quotes and backslashes instead of running it as SQL', async () => {
    const odd = { app: `it's "a" \\ password; drop table x;--`, migrator: `back\\slash'quote-0123456789`, ops: `"ops" it's; \\-0123456789` };
    await setup(SUPER, odd);
    expect(await canConnect(ROLES.app, odd.app)).toBe(true);
    expect(await canConnect(ROLES.migrator, odd.migrator)).toBe(true);
    expect(await canConnect(ROLES.ops, odd.ops)).toBe(true);
  });
});

describe('setupDatabase on a database that is not clean', () => {
  const OTHER = `t_other_${ID}`;
  const reset = () => asSuperuser('postgres', async (q) => {
    await q(`drop database if exists ${DATABASE} with (force)`);
    for (const role of [ROLES.ops, ROLES.app, ROLES.migrator, OTHER]) await q(`drop role if exists ${role}`);
    await q(`create database ${DATABASE}`);
  });
  const roleFlags = (role: string) => asSuperuser('postgres', (q) => q(`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = $1`, [role]));

  it('resets the attributes an existing runtime role carries', async () => {
    await reset();
    await asSuperuser('postgres', (q) => q(`create role ${ROLES.app} login createdb createrole replication bypassrls`));
    expect(await roleFlags(ROLES.app)).toEqual([{ rolsuper: false, rolcreatedb: true, rolcreaterole: true, rolreplication: true, rolbypassrls: true }]);
    await setup(SUPER, PASSWORDS);
    expect(await roleFlags(ROLES.app)).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
  });

  it('resets an expired password and a connection limit of 0, which would keep an existing role from logging in', async () => {
    await reset();
    await asSuperuser('postgres', (q) => q(`create role ${ROLES.app} login connection limit 0 valid until '2000-01-01' password 'old-password-0123456789'`));
    expect(await canConnect(ROLES.app, 'old-password-0123456789')).toBe(false);
    await setup(SUPER, PASSWORDS);
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(true);
    expect(await asSuperuser('postgres', (q) => q('select rolconnlimit, rolvaliduntil::text as until from pg_roles where rolname = $1', [ROLES.app]))).toEqual([{ rolconnlimit: -1, until: 'infinity' }]);
  });

  it('refuses a role that is a member of another role, and changes nothing', async () => {
    await reset();
    await asSuperuser('postgres', async (q) => { await q(`create role ${OTHER}`); await q(`create role ${ROLES.app} login`); await q(`grant ${OTHER} to ${ROLES.app}`); });
    await expect(setup(SUPER, PASSWORDS)).rejects.toThrow(/is a member of/);
    expect(await asSuperuser('postgres', (q) => q('select 1 from pg_roles where rolname = $1', [ROLES.migrator]))).toEqual([]); // not even the migration role was made
  });

  it('hands a pgboss schema that is already there under another owner to the migration role', async () => {
    await reset();
    await asSuperuser('postgres', (q) => q(`create role ${OTHER}`));
    await asSuperuser(DATABASE, (q) => q(`create schema pgboss authorization ${OTHER}`));
    await setup(SUPER, PASSWORDS);
    expect(await asSuperuser(DATABASE, (q) => q(`select r.rolname as owner from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = 'pgboss'`))).toEqual([{ owner: ROLES.migrator }]);
  });

  it('leaves the database as it was when a step fails part-way: no role made, no password changed', async () => {
    await reset();
    await setup(SUPER, PASSWORDS);
    const handle = createDatabase(url(SUPER.role, SUPER.password, DATABASE), { maxConnections: 1 });
    const failing = { ...handle, transaction: <T>(fn: Parameters<typeof handle.transaction<T>>[0]) => handle.transaction((tx) => fn({ query: (text, params) => (/create extension/.test(text) ? Promise.reject(new Error('the step failed')) : tx.query(text, params)) })) };
    try {
      await expect(setupDatabase(failing as typeof handle, ROTATED, ROLES)).rejects.toThrow('the step failed');
    } finally { await handle.close(); }
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(true); // the rotation was rolled back
    expect(await canConnect(ROLES.app, 'rotated-app-password-0123456789')).toBe(false);
  });
});

describe('setupDatabase as the master user of a managed service (not a superuser)', () => {
  it('does the same, which needs the right to become the migration role to give it the schemas', async () => {
    await asSuperuser('postgres', async (q) => {
      await q(`drop database if exists ${DATABASE} with (force)`);
      for (const role of [ROLES.ops, ROLES.app, ROLES.migrator, MANAGED_ADMIN]) await q(`drop role if exists ${role}`);
      await q(`create role ${MANAGED_ADMIN} login createrole password 'managed-admin-password-0123'`);
      await q(`create database ${DATABASE} owner ${MANAGED_ADMIN}`);
    });
    const result = await setup({ role: MANAGED_ADMIN, password: 'managed-admin-password-0123' }, PASSWORDS);
    expect(result).toEqual({ created: [ROLES.migrator, ROLES.app, ROLES.ops], updated: [] });
    expect(await canConnect(ROLES.ops, PASSWORDS.ops)).toBe(true); // the master user could make it a member of the runtime role
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(true);
    const owner = await asSuperuser(DATABASE, (q) => q(`select r.rolname as owner from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = 'public'`));
    expect(owner).toEqual([{ owner: ROLES.migrator }]);
  });

  it('can run again and rotate the passwords, which on PostgreSQL 16 and later a non-superuser may not do to the privilege attributes of a role that has none', async () => {
    const managed = { role: MANAGED_ADMIN, password: 'managed-admin-password-0123' };
    const rotated = ROTATED;
    expect(await setup(managed, rotated)).toEqual({ created: [], updated: [ROLES.migrator, ROLES.app, ROLES.ops] });
    expect(await canConnect(ROLES.app, rotated.app)).toBe(true);
    expect(await canConnect(ROLES.app, PASSWORDS.app)).toBe(false);
  });

  it('says what to do when an existing role has an attribute the administrator may not reset, and changes nothing', async () => {
    await asSuperuser('postgres', (q) => q(`alter role ${ROLES.app} createdb`));
    await expect(setup({ role: MANAGED_ADMIN, password: 'managed-admin-password-0123' }, PASSWORDS)).rejects.toThrow(/cannot reset nocreatedb on the existing role .*superuser/);
    expect(await canConnect(ROLES.app, 'rotated-app-password-0123456789')).toBe(true); // the rotation of the migration role and of the others was rolled back with it
    await asSuperuser('postgres', (q) => q(`alter role ${ROLES.app} nocreatedb`));
  });
});

describe('the operator role (docs/tenancy.md section 3.2): the runtime role plus nothing but a login of its own', () => {
  const OTHER = `t_other_ops_${ID}`;
  const as = <T>(role: string, password: string, work: Parameters<typeof run<T>>[1]) => run(url(role, password, DATABASE), work);
  const message = (p: Promise<unknown>): Promise<string> => p.then(() => 'ran', (e: unknown) => (e instanceof Error ? e.message : 'error'));
  const flags = () => asSuperuser('postgres', (q) => q('select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit from pg_roles where rolname = $1', [ROLES.ops]));
  const memberOf = () => asSuperuser('postgres', (q) => q('select g.rolname as "group" from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where r.rolname = $1', [ROLES.ops]));

  beforeAll(async () => {
    await asSuperuser('postgres', async (q) => {
      await q(`drop database if exists ${DATABASE} with (force)`);
      for (const role of [ROLES.ops, ROLES.app, ROLES.migrator, OTHER]) await q(`drop role if exists ${role}`);
      await q(`create database ${DATABASE}`);
    });
    await setup(SUPER, PASSWORDS);
    await as(ROLES.migrator, PASSWORDS.migrator, async (q) => { await q('create table shared (id int)'); await q(`grant select, insert on shared to ${ROLES.app}`); });
  }, 60_000);

  it('has no attribute but login and inherit: not bypassrls (an RDS master user may not grant it), not superuser, no createdb, no createrole', async () => {
    expect(await flags()).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: true }]);
  });

  it('is a member of the runtime role only, and so has its grants without any of its own', async () => {
    expect(await memberOf()).toEqual([{ group: ROLES.app }]);
    expect(await as(ROLES.ops, PASSWORDS.ops, async (q) => { await q('insert into shared values (1)'); return q('select id from shared'); })).toEqual([{ id: 1 }]);
  });

  it('cannot change the schema: no new table, no altered one', async () => {
    expect(await message(as(ROLES.ops, PASSWORDS.ops, (q) => q('create table public.mine (id int)')))).toMatch(/permission denied/);
    expect(await message(as(ROLES.ops, PASSWORDS.ops, (q) => q('alter table shared add column x int')))).toMatch(/must be owner/);
  });

  it('cannot become the migration role or the administrator', async () => {
    expect(await message(as(ROLES.ops, PASSWORDS.ops, (q) => q(`set role ${ROLES.migrator}`)))).toMatch(/permission denied to set role/);
    expect(await message(as(ROLES.ops, PASSWORDS.ops, (q) => q(`set role ${SUPER.role}`)))).toMatch(/permission denied to set role/);
  });

  it('a run takes bypassrls back from an existing operator role, and refuses one that is a member of any other role', async () => {
    await asSuperuser('postgres', (q) => q(`alter role ${ROLES.ops} bypassrls`));
    await setup(SUPER, PASSWORDS);
    expect(await flags()).toEqual([expect.objectContaining({ rolbypassrls: false })]);
    await asSuperuser('postgres', async (q) => { await q(`create role ${OTHER}`); await q(`grant ${OTHER} to ${ROLES.ops}`); });
    await expect(setup(SUPER, PASSWORDS)).rejects.toThrow(new RegExp(`${ROLES.ops} is a member of ${OTHER}`));
  });
});

describe('setupDatabase refuses what it must not do before it touches the database', () => {
  const refuses = async (passwords: Passwords, roles: DatabaseRoles = ROLES): Promise<string> => {
    const handle = createDatabase(url(SUPER.role, SUPER.password, DATABASE), { maxConnections: 1 });
    try { await setupDatabase(handle, passwords, roles); return 'ran'; } catch (e) { return e instanceof Error ? e.message : 'error'; } finally { await handle.close(); }
  };
  it('a short password, equal roles and a role name that is not plain', async () => {
    expect(await refuses({ ...PASSWORDS, app: 'short' })).toMatch(/at least 16/);
    expect(await refuses({ ...PASSWORDS, ops: 'short' })).toMatch(/at least 16/);
    expect(await refuses(PASSWORDS, { app: 'same_role', migrator: 'same_role', ops: 'ops_role' })).toMatch(/different roles/);
    expect(await refuses(PASSWORDS, { app: 'app_role', migrator: 'migrator_role', ops: 'app_role' })).toMatch(/different roles/);
    expect(await refuses(PASSWORDS, { app: 'x; drop role y', migrator: 'ok_role', ops: 'ops_role' })).toMatch(/lowercase letters/);
  });
});
