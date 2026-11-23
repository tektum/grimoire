import net from 'node:net';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseConformance } from '@tektum/grimoire-core/testing/database-conformance';
import { insertPage } from '@tektum/grimoire-test-support/database';
import { createDatabase } from '../src/index.js';

// Runs against the Compose PostgreSQL (`make db-up`). Dev-only credentials from the contracts file.
// Its own database, so no other user of the stack loses data; dropped in afterAll.
const DB = `grimoire_t_dbkysely_${String(process.pid)}`;
const SERVER = '127.0.0.1:55432';
const HOST = `${SERVER}/${DB}`;
const URLS = {
  admin: `postgresql://grimoire_admin:grimoire-dev@${HOST}`,
  migrator: `postgresql://grimoire_migrator:grimoire-dev@${HOST}`,
  app: `postgresql://grimoire_app:grimoire-dev@${HOST}`,
};
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = path.join(ROOT, 'apps/server/dist/cli.js');
const WORK = path.join(ROOT, 'packages/adapters/db-kysely/test/.work', `p${String(process.pid)}`); // inside the repo so test migrations can import kysely

async function sqlAs<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

interface Run { code: number; out: string; lines: Record<string, unknown>[] }
function migrate(opts: { dir?: string; url?: string | null } = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GRIMOIRE_DATABASE_MIGRATION_URL;
  if (opts.url !== null) env.GRIMOIRE_DATABASE_MIGRATION_URL = opts.url ?? URLS.migrator;
  const args = [CLI, 'migrate', ...(opts.dir ? ['--dir', opts.dir] : [])];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env }, (err, stdout, stderr) => {
      const out = stdout + stderr;
      const lines = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out, lines });
    });
  });
}

let seq = 0;
async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = path.join(WORK, `d${process.pid}-${seq++}`);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  return dir;
}
const sqlMigration = (stmt: string): string =>
  `import { sql } from 'kysely';\nexport async function up(db: unknown): Promise<void> {\n  await sql\`${stmt}\`.execute(db as never);\n}\n`;

// Empties the schema the way db/init/roles.psql set it up: drop it, then replay that file's schema/ownership part.
async function resetDatabase(): Promise<void> {
  const init = await readFile(path.join(ROOT, 'db/init/roles.psql'), 'utf8');
  const tail = init.slice(init.indexOf('ALTER SCHEMA public OWNER'));
  await sqlAs(URLS.admin, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${tail}`);
}

beforeAll(async () => {
  // Build so the compiled CLI and the core testing helpers are current.
  await new Promise<void>((resolve, reject) =>
    execFile(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-b'], { cwd: ROOT }, (e, o) => (e ? reject(new Error(`tsc -b failed:\n${o}`)) : resolve())),
  );
  await sqlAs(`postgresql://grimoire_admin:grimoire-dev@${SERVER}/postgres`, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await sqlAs(`postgresql://grimoire_admin:grimoire-dev@${SERVER}/postgres`, `CREATE DATABASE ${DB} OWNER grimoire_migrator`);
  await mkdir(WORK, { recursive: true });
}, 120_000);
afterAll(async () => {
  await sqlAs(`postgresql://grimoire_admin:grimoire-dev@${SERVER}/postgres`, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await rm(WORK, { recursive: true, force: true });
});
beforeEach(resetDatabase, 60_000);

const tables = async (): Promise<string[]> =>
  (await sqlAs<{ tablename: string }>(URLS.admin, "select tablename from pg_tables where schemaname = 'public' order by 1")).map((r) => r.tablename);
const migrationRows = async (): Promise<string[]> =>
  (await sqlAs<{ name: string }>(URLS.admin, 'select name from kysely_migration order by name')).map((r) => r.name);

describe('grimoire migrate', () => {
  it('applies on an empty database and is idempotent on a second run', async () => {
    const first = await migrate();
    expect(first.code).toBe(0);
    expect(first.lines.at(-1)).toMatchObject({ event: 'migrate.done', applied: 8 }); // 0001 to 0008
    expect(await tables()).toEqual(expect.arrayContaining(['kysely_migration', 'pages']));
    const rows = await migrationRows();
    expect(rows).toEqual(['0001_pages', '0002_page_markdown', '0003_schema_version', '0004_permissions', '0005_history_files_imports_audit', '0006_page_search_and_positions', '0007_idempotency_created_index', '0008_drop_page_defaults']);

    const second = await migrate();
    expect(second.code).toBe(0);
    expect(second.out).toContain('migrate.nothing_pending');
    expect(second.out).toContain('"applied":0');
    expect(second.lines.at(-1)).toMatchObject({ event: 'migrate.done', applied: 0 });
    expect(await migrationRows()).toEqual(rows);
  });

  it('exits 2 and names the variable when GRIMOIRE_DATABASE_MIGRATION_URL is unset', async () => {
    const r = await migrate({ url: null });
    expect(r.code).toBe(2);
    expect(r.out).toContain('GRIMOIRE_DATABASE_MIGRATION_URL');
  });

  it('exits 1 on a wrong password and prints neither the password nor the URL', async () => {
    const r = await migrate({ url: `postgresql://grimoire_migrator:Wr0ng-s3cret@${HOST}` });
    expect(r.code).toBe(1);
    expect(r.out).toContain('password authentication failed');
    expect(r.out).not.toContain('Wr0ng-s3cret');
    expect(r.out).not.toContain('postgresql://');
  });

  it('does not run an applied migration again', async () => {
    const dir = await migrationDir({
      '0001_scratch.ts': sqlMigration('create table scratch(n int); insert into scratch values (1)'),
    });
    expect((await migrate({ dir })).code).toBe(0);
    expect((await migrate({ dir })).code).toBe(0);
    expect(await sqlAs(URLS.admin, 'select n from scratch')).toHaveLength(1);
  });

  it('two processes started together both exit 0 and the migration runs once (Migrator lock)', async () => {
    const dir = await migrationDir({
      '0001_scratch.ts': sqlMigration('create table scratch(n int); insert into scratch values (1)'),
    });
    const [a, b] = await Promise.all([migrate({ dir }), migrate({ dir })]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(await sqlAs(URLS.admin, 'select n from scratch')).toHaveLength(1);
    expect(await migrationRows()).toEqual(['0001_scratch']);
  });

  it('refuses when an applied migration file has been removed', async () => {
    const dir = await migrationDir({
      '0001_one.ts': sqlMigration('create table one(n int)'),
      '0002_two.ts': sqlMigration('create table two(n int)'),
    });
    expect((await migrate({ dir })).code).toBe(0);
    await rm(path.join(dir, '0001_one.ts'));
    const r = await migrate({ dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('0001_one');
    expect(await migrationRows()).toEqual(['0001_one', '0002_two']);
  });

  it('refuses a new migration that sorts before an applied one', async () => {
    const dir = await migrationDir({ '0002_two.ts': sqlMigration('create table two(n int)') });
    expect((await migrate({ dir })).code).toBe(0);
    await writeFile(path.join(dir, '0001_early.ts'), sqlMigration('create table early(n int)'));
    const r = await migrate({ dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('0001_early');
    expect(await migrationRows()).toEqual(['0002_two']);
    expect(await tables()).not.toContain('early');
  });

  it('a failing migration leaves the database unchanged and exits 1 naming it', async () => {
    const dir = await migrationDir({
      '0001_ok.ts': sqlMigration('create table ok(n int)'),
      '0002_bad.ts': sqlMigration('create table half(n int); select 1/0'),
    });
    const r = await migrate({ dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('0002_bad');
    const t = await tables();
    expect(t).not.toContain('half');
    expect(t).not.toContain('ok'); // one transaction for the whole batch
    expect(await migrationRows()).toEqual([]);
  });
});

describe('database roles after migration', () => {
  it('runtime role reads and writes pages but cannot change the schema; migration role can', async () => {
    expect((await migrate()).code).toBe(0);
    const app = new pg.Client({ connectionString: URLS.app });
    await app.connect();
    try {
      await expect(app.query('create table x()')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('alter table pages add column y int')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('drop table pages')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('truncate pages')).rejects.toMatchObject({ code: '42501' });
      for (const [t, col] of [['kysely_migration', 'name'], ['kysely_migration_lock', 'id']] as const) {
        for (const q of [`select * from ${t}`, `insert into ${t} default values`, `update ${t} set ${col} = ${col}`, `delete from ${t}`])
          await expect(app.query(q)).rejects.toMatchObject({ code: '42501' });
      }
      expect((await app.query("select to_regclass('kysely_migration') as r")).rows[0]?.r).toBe('kysely_migration'); // readiness check needs no table privilege
      const id = '11111111-1111-4111-8111-111111111111';
      await insertPage((sql) => app.query(sql), { id, ydoc: Buffer.from([1, 2, 3]) });
      expect((await app.query('select ydoc, state_epoch from pages where id = $1', [id])).rows).toEqual([{ ydoc: Buffer.from([1, 2, 3]), state_epoch: 0 }]);
      await app.query('update pages set state_epoch = 1 where id = $1', [id]);
      expect((await app.query('delete from pages where id = $1', [id])).rowCount).toBe(1);
    } finally {
      await app.end();
    }
    await sqlAs(URLS.migrator, 'create table x(); drop table x');
    expect((await sqlAs<{ tableowner: string }>(URLS.admin, "select tableowner from pg_tables where tablename = 'pages'"))[0]?.tableowner).toBe('grimoire_migrator');
  });
});

describe('least privilege', () => {
  it('a later migration without an explicit grant is not accessible to the runtime role', async () => {
    const dir = await migrationDir({ '0001_nogrant.ts': sqlMigration('create table nogrant(n int)') });
    expect((await migrate({ dir })).code).toBe(0);
    await expect(sqlAs(URLS.app, 'select * from nogrant')).rejects.toMatchObject({ code: '42501' });
  });

  it('\\dp-equivalent: the runtime role holds rights only on the permission tables and the 0005 tables, each with its exact privileges', async () => {
    expect((await migrate()).code).toBe(0);
    const rows = await sqlAs<{ t: string; p: string }>(URLS.admin, "select c.relname as t, string_agg(p, ',' order by p) as p from pg_class c cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(p) where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_table_privilege('grimoire_app', c.oid, p) group by 1");
    const crud = 'DELETE,INSERT,SELECT,UPDATE';
    const expected = [
      ...['collection_access', 'collections', 'group_members', 'groups', 'pages', 'users', 'attachments', 'idempotency_keys'].map((t) => ({ t, p: crud })),
      ...['revisions', 'audit_events'].map((t) => ({ t, p: 'INSERT,SELECT' })),
      ...['imports', 'import_items'].map((t) => ({ t, p: 'INSERT,SELECT,UPDATE' })),
    ].sort((a, b) => a.t.localeCompare(b.t));
    expect([...rows].sort((a, b) => a.t.localeCompare(b.t))).toEqual(expected);
  });
});

describe('migration file errors and typecheck', () => {
  it('a syntax error names the migration file', async () => {
    const dir = await migrationDir({ '0001_broken.ts': 'export async function up( {\n' });
    const r = await migrate({ dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('0001_broken.ts');
  });

  it('a migration using an enum fails the migrations typecheck (erasableSyntaxOnly)', async () => {
    const dir = await migrationDir({});
    await writeFile(path.join(dir, 'enum.ts'), await readFile(path.join(ROOT, 'db/migration-fixtures/enum.ts.txt'), 'utf8'));
    await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ extends: path.join(ROOT, 'db/migrations/tsconfig.json'), compilerOptions: { composite: false, emitDeclarationOnly: false, noEmit: true, rootDir: '.', tsBuildInfoFile: null }, include: ['enum.ts'] }));
    const out = await new Promise<{ failed: boolean; text: string }>((resolve) =>
      execFile(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', dir], (e, o) => resolve({ failed: e !== null, text: o })),
    );
    expect(out.failed).toBe(true);
    expect(out.text).toContain('TS1294');
  });
});

describe('Kysely adapter', () => {
  const openConnections = async (): Promise<number> =>
    Number((await sqlAs<{ n: string }>(URLS.admin, `select count(*) as n from pg_stat_activity where usename = 'grimoire_app' and datname = '${DB}' and application_name = 'db-kysely-ping-test'`))[0]?.n);

  it('passes the Database conformance cases on a real database', async () => {
    await sqlAs(URLS.migrator, 'create table conformance_items (id int, name text)');
    const db = createDatabase(URLS.migrator);
    for (const c of databaseConformance) await c.run(db); // cases build on each other, so run in order
  });

  it('pings as the runtime role, then close ends the pool and leaves no connection open', async () => {
    const db = createDatabase(`${URLS.app}?application_name=db-kysely-ping-test`); // counted by name: other files may hold connections
    await db.ping();
    expect(await openConnections()).toBeGreaterThan(0);
    await db.close();
    // The server drops the backend a moment after the client closes: wait for that state, bounded.
    await vi.waitFor(async () => { expect(await openConnections()).toBe(0); }, { timeout: 5000, interval: 50 });
  });

  it('ping rejects when the server refuses the login, without leaking the password', async () => {
    const db = createDatabase(`postgresql://grimoire_app:Wr0ng-s3cret@${HOST}`);
    const err = await db.ping().then(() => undefined, (e: unknown) => e as Error);
    await db.close();
    expect(err?.message).toContain('password authentication failed');
    expect(err?.message).not.toContain('Wr0ng-s3cret');
  });

  it('a query that needs a new connection to a server that accepts and never answers fails within the connection timeout', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => { sockets.add(s); s.on('error', () => undefined); }); // accepts, then stays silent: the handshake hangs
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as net.AddressInfo;
    const db = createDatabase(`postgresql://u:p@127.0.0.1:${String(port)}/x`, { connectionTimeoutMs: 300, queryTimeoutMs: 300, closeTimeoutMs: 100 });
    try {
      const startedAt = Date.now();
      await expect(db.query('select 1')).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(300 + 700);
    } finally {
      await db.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
