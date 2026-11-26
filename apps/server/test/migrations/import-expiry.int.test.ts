import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../server/support/harness.js';

// Each run of the migrator is a process that also runs pg-boss's own migration.
vi.setConfig({ testTimeout: 120_000 });

const DB = 'grimoire_m7_import_expiry';

const migrate = async (settings: Record<string, string>): Promise<void> => {
  const run = await runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB), ...settings });
  if (run.code !== 0) throw new Error(`migrate failed: ${run.output}`);
};
const expiry = async (): Promise<number> => Number((await sqlAdmin<{ n: string }>(DB, "select expire_seconds as n from pgboss.queue where name = 'import'"))[0]?.n);

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, false);
}, 60_000);
afterAll(async () => {
  await dropTestDatabase(DB);
});

it('the import queue expires a run after the seconds the migrate command was given, on a new database and on one already migrated', async () => {
  await migrate({});
  expect(await expiry(), 'the default').toBe(900);
  await migrate({ GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: '20' });
  expect(await expiry(), 'a queue that exists takes the new expiry, in place').toBe(20);
  await migrate({});
  expect(await expiry(), 'and goes back when the setting is gone').toBe(900);
});
