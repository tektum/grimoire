import path from 'node:path';
import pg from 'pg';
import pgBossPackage from 'pg-boss/package.json' with { type: 'json' };
import { getRollbackPlans } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

const DB = 'grimoire_m7t02_version';
const migrate = () => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });
const installed = async () => Number((await sqlAdmin<{ version: number }>(DB, 'select version from pgboss.version'))[0]?.version);

/** The schema version the installed library expects: pg-boss declares it in its own package.json. */
const expected = pgBossPackage.pgboss.schema;

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, false);
}, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('the pg-boss schema version', () => {
  it('is the one the library expects after grimoire migrate', async () => {
    const run = await migrate();
    expect(run.code, run.output).toBe(0);
    expect(await installed()).toBe(expected);
  }, 120_000);

  it('is upgraded by grimoire migrate from the version before it', async () => {
    const client = new pg.Client({ connectionString: migratorUrl(DB) });
    await client.connect();
    try {
      await client.query(getRollbackPlans('pgboss', expected));
    } finally {
      await client.end();
    }
    expect(await installed()).toBe(expected - 1);
    const run = await migrate();
    expect(run.code, run.output).toBe(0);
    expect(await installed()).toBe(expected);
  }, 120_000);
});
