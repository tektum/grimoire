import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { insertCollection, insertSql, insertUser } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// Each `migrate` starts the migrator as a process: slower than vitest's 5 s default on a loaded runner.
vi.setConfig({ testTimeout: 120_000 });

// Migration 0015 (the parts of an import) on a database at 0014 that already holds imports: the zip an import has is copied as its part 0.
const DB = 'grimoire_m7_import_parts';
const upTo0014 = path.join(repoRoot, 'test-results', 'm7-migrations-0014');
const run = (text: string) => sqlAdmin(DB, text);
const migrate = (dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });

beforeAll(async () => {
  requireBuild();
  mkdirSync(upTo0014, { recursive: true });
  for (const name of readdirSync(path.join(repoRoot, 'db/migrations')).filter((n) => /^00(0\d|1[0-4])_.*\.ts$/.test(n))) cpSync(path.join(repoRoot, 'db/migrations', name), path.join(upTo0014, name));
  await createTestDatabase(DB, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0014, { recursive: true, force: true });
  await dropTestDatabase(DB);
});

describe('migration 0015', () => {
  it('copies the zip of each import that has one as part 0 with its size, leaves an import with none without a part, and a second run applies nothing', async () => {
    const first = await migrate(upTo0014);
    expect(first.code, first.output).toBe(0);
    const user = await insertUser(run, {});
    const collection = await insertCollection(run, { created_by: user });
    await run(insertSql('imports', { id: 'a0000000-3c1d-4a53-9a62-5d1c2a7e8f10', target_collection_id: collection, created_by: user, source: 'markdown_zip', s3_key: 'tenants/t/imports/a/source.zip', bytes: 1234 }));
    await run(insertSql('imports', { id: 'b0000000-3c1d-4a53-9a62-5d1c2a7e8f10', target_collection_id: collection, created_by: user, source: 'markdown_zip' }));

    const second = await migrate();
    expect(second.code, second.output).toBe(0);
    const parts = (await run(`select import_id::text as import_id, tenant_id, ordinal::int as ordinal, s3_key, bytes::text as bytes, upload_id from import_parts order by import_id, ordinal`)) as Record<string, unknown>[];
    expect(parts).toEqual([{ import_id: 'a0000000-3c1d-4a53-9a62-5d1c2a7e8f10', tenant_id: 'legacy', ordinal: 0, s3_key: 'tenants/t/imports/a/source.zip', bytes: '1234', upload_id: null }]);

    const again = await migrate();
    expect(again.code, again.output).toBe(0);
    expect(((await run(`select count(*)::int as n from import_parts`)) as { n: number }[])[0]?.n).toBe(1);
  });
});
