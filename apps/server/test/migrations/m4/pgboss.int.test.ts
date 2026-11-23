import path from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { createJobQueue } from '@tektum/grimoire-adapter-jobs-pgboss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

const DB = 'grimoire_m4t11_pgboss';
const migrate = () => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });

async function sqlAsApp<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: appUrl(DB) });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

/** The PostgreSQL error code of an error, looking through `cause` in case pg-boss wraps it. */
function sqlState(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

const privileges = () => sqlAdmin<{ name: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(DB,
  `select c.relname as name,
          has_table_privilege('grimoire_app', c.oid, 'select') as sel, has_table_privilege('grimoire_app', c.oid, 'insert') as ins,
          has_table_privilege('grimoire_app', c.oid, 'update') as upd, has_table_privilege('grimoire_app', c.oid, 'delete') as del
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'pgboss' and c.relkind in ('r', 'p') order by c.relname`);

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, false);
}, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('grimoire migrate installs pg-boss', () => {
  it('creates the pgboss schema after the Kysely migrations and grants the runtime role table by table', async () => {
    const run = await migrate();
    expect(run.code, run.out).toBe(0);
    const tables = await privileges();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['job', 'job_common', 'queue', 'version']));
    for (const t of tables) {
      expect({ name: t.name, sel: t.sel }).toEqual({ name: t.name, sel: true });
      const full = t.name !== 'version'; // version: the loops update its timestamps, nothing else
      expect({ name: t.name, ins: t.ins, upd: t.upd, del: t.del }).toEqual({ name: t.name, ins: full, upd: true, del: full });
    }
  }, 120_000);

  it('is repeatable: a second run succeeds and changes no grant', async () => {
    const before = await privileges();
    const run = await migrate();
    expect(run.code, run.out).toBe(0);
    expect(await privileges()).toEqual(before);
  }, 120_000);

  it('lets the runtime role enqueue and read a job on a queue made by the migration role', async () => {
    // Made by the migration role AFTER the migrate command ran: the runtime role gets its partition through default privileges.
    const admin = new PgBoss({ connectionString: migratorUrl(DB), schema: 'pgboss', migrate: false, supervise: false, schedule: false, registerInstance: false });
    admin.on('error', () => undefined);
    await admin.start();
    await admin.createQueue('m4-grants');
    await admin.stop({ graceful: true, close: true, timeout: 2000 });
    const errors: Error[] = [];
    const queue = await createJobQueue({ connectionString: appUrl(DB), max: 2, onError: (e) => errors.push(e) });
    try {
      expect(await queue.enqueue('m4-grants', { hello: 'world' })).toEqual(expect.any(String));
      expect(await queue.isLive()).toBe(true);
    } finally {
      await queue.stop({ graceMs: 0 });
    }
    expect((await sqlAsApp<{ n: number }>("select count(*)::int as n from pgboss.job where name = 'm4-grants'"))[0]?.n).toBe(1);
    expect(errors.map((e) => e.message)).toEqual([]);
    // The maintenance and cron loops take their turn by updating a timestamp of the version row; the runtime role may.
    await sqlAsApp('update pgboss.version set cron_on = cron_on');
  }, 120_000);

  it('does not let the runtime role create a queue: that is DDL and belongs to the migration role', async () => {
    // pg-boss may reject the call or report the failure through its error event; either way the PostgreSQL privilege error must be there.
    const reported: unknown[] = [];
    const queue = await createJobQueue({ connectionString: appUrl(DB), max: 2, onError: (e) => reported.push(e) });
    let rejection: unknown;
    try {
      await queue.ensureQueue('m4-runtime-made');
    } catch (e) {
      rejection = e;
    } finally {
      await queue.stop({ graceMs: 0 });
    }
    const states = [rejection, ...reported].filter((e) => e !== undefined).map(sqlState);
    expect(states, 'creating a queue as the runtime role must fail with insufficient_privilege (42501)').toContain('42501');
    expect(await sqlAdmin<{ name: string }>(DB, "select name from pgboss.queue where name = 'm4-runtime-made'")).toEqual([]);
  }, 120_000);
});
