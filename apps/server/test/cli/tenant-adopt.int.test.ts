import path from 'node:path';
import { insertTenantRows, TENANT_TABLES } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../server/support/harness.js';

// `grimoire tenant-adopt` as a process, on a migrated database whose `legacy` tenant holds rows in every tenant table. What each refusal leaves
// untouched, and the move into a tenant that already exists, are tested on the adapter (packages/adapters/db-kysely/test/tenant-adopt).
const DB = 'grimoire_t_tenant_adopt';
const cli = path.join(serverDir, 'dist/cli.js');
const adopt = (...args: string[]) => runToEnd([cli, 'tenant-adopt', ...args], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });
const counts = async (tenantId: string) =>
  Object.fromEntries(await Promise.all(TENANT_TABLES.map(async (table) => [table, (await sqlAdmin<{ n: number }>(DB, `select count(*)::int as n from ${table} where tenant_id = '${tenantId}'`))[0]?.n])));
let emails: string[] = [];

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  for (let i = 0; i < 2; i += 1) await insertTenantRows((statement) => sqlAdmin(DB, statement), 'legacy');
  emails = (await sqlAdmin<{ email: string }>(DB, `select email from users`)).map((row) => row.email);
}, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('grimoire tenant-adopt', () => {
  it('is listed in the usage line, and a bad argument is a usage error (exit 2)', async () => {
    const none = await runToEnd([cli, 'nothing'], {});
    expect(none.code).toBe(2);
    expect(none.output).toContain('grimoire tenant-adopt');
    const bad = await adopt('--from', 'legacy');
    expect(bad.code).toBe(2);
    expect(bad.output).toContain('usage: grimoire tenant-adopt --from <tenant id> --to <tenant id>');
  });

  it('exits 2 without the migrator connection', async () => {
    const result = await runToEnd([cli, 'tenant-adopt', '--from', 'legacy', '--to', 'acme'], {});
    expect(result.code).toBe(2);
    expect(result.output).toContain('tenant_adopt.config_invalid');
    expect(result.output).toContain('GRIMOIRE_DATABASE_MIGRATION_URL');
  });

  it('refuses a new tenant without its name and domain, and an id of the wrong shape (exit 1, nothing moved)', async () => {
    const before = await counts('legacy');
    for (const [args, reason] of [[['--to', 'acme'], 'target-unnamed'], [['--to', 'a/b', '--name', 'Acme', '--domain', 'acme.example'], 'bad-tenant-id']] as const) {
      const result = await adopt('--from', 'legacy', ...args);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('"tenant_adopt.refused"');
      expect(result.output).toContain(`"reason":"${reason}"`);
    }
    expect(await counts('legacy')).toEqual(before);
  });

  it('moves the legacy workspace into a new tenant, prints the counts and no personal data, keeps the legacy row, and a second run is refused', async () => {
    const before = await counts('legacy');
    const result = await adopt('--from', 'legacy', '--to', 'acme', '--name', 'Acme Corp', '--domain', 'acme.example');
    expect(result.code, result.output).toBe(0);
    const done = result.output.split('\n').filter((line) => line.includes('"tenant_adopt.done"')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ from: 'legacy', to: 'acme', tenantCreated: true, moved: before, sourceTenantRow: 'kept' });
    for (const secret of [...emails, 'Acme Corp', 'acme.example']) expect(result.output).not.toContain(secret);
    expect(await counts('acme')).toEqual(before);
    expect(await sqlAdmin(DB, `select id from tenants where id = 'legacy'`)).toEqual([{ id: 'legacy' }]);

    const again = await adopt('--from', 'legacy', '--to', 'acme', '--name', 'Acme Corp', '--domain', 'acme.example');
    expect(again.code).toBe(1);
    expect(again.output).toContain('"reason":"source-empty"');
    expect(await counts('acme')).toEqual(before);
  });
});
