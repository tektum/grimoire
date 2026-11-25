import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, eventually, get, migratorUrl, requireBuild, runToEnd, sqlAdmin, startServer,
} from './support/harness.js';
import { serverDir } from './support/harness.js';
import path from 'node:path';

const DB = 'grimoire_t_readyz';

beforeAll(async () => { requireBuild(); }, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('/readyz follows the database', () => {
  it('turns 503 within the cache time when the schema disappears, and is 503 while the newest migration is pending', async () => {
    await createTestDatabase(DB, true); // own database: the schema drop below touches nothing else
    const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB) } });
    try {
      const url = `http://127.0.0.1:${s.port}/readyz`;
      expect(await get(url)).toEqual({ status: 200, body: 'ok' });
      await sqlAdmin(DB, 'drop schema public cascade; create schema public');
      await eventually(async () => ((await get(url)).status === 503 ? true : undefined), 4000, '/readyz 503 after the schema is dropped');
      // Recreated and fully migrated: ready again; then the newest migration is made pending by hand.
      await sqlAdmin(DB, 'drop schema public cascade; create schema public; alter schema public owner to grimoire_migrator; grant usage on schema public to grimoire_app; create extension if not exists vector'); // vector went with the schema, and only the administrator can make it again
      const dir = path.join(serverDir, '../../db/migrations');
      const again = await runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', '--dir', dir], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });
      expect(again.code).toBe(0);
      await eventually(async () => ((await get(url)).status === 200 ? true : undefined), 4000, '/readyz 200 once fully migrated again');
      await sqlAdmin(DB, "delete from kysely_migration where name = '0003_schema_version'");
      await sqlAdmin(DB, 'drop function grimoire_schema_version()');
      await eventually(async () => ((await get(url)).status === 503 ? true : undefined), 4000, '/readyz 503 while the newest migration is not applied');
    } finally {
      await s.kill();
    }
  }, 60_000);
});
