import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireBuild, runToEnd, serverDir } from '../server/support/harness.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

// Runs `grimoire db-setup` as a process. What it does to a database is tested against the Compose database with other role names
// (packages/adapters/db-kysely/test/setup.int.test.ts): the product's own role names are cluster-wide and the shared development database must keep its passwords.
const cli = path.join(serverDir, 'dist/cli.js');
const APP = 'app-password-0123456789';
const MIGRATOR = 'migrator-password-0123456789';
const ADMIN_PASSWORD = 'not-the-admin-password-0123';
const run = (env: Record<string, string>) => runToEnd([cli, 'db-setup'], env);
const leaks = (output: string): string[] => [APP, MIGRATOR, ADMIN_PASSWORD].filter((secret) => output.includes(secret));

beforeAll(() => requireBuild());

describe('grimoire db-setup', () => {
  it('is listed in the usage line', async () => {
    const result = await runToEnd([cli, 'nothing'], {});
    expect(result.code).toBe(2);
    expect(result.output).toContain('grimoire db-setup');
  });

  it('exits 2 and names every missing setting, without a value', async () => {
    const result = await run({});
    expect(result.code).toBe(2);
    for (const name of ['GRIMOIRE_DATABASE_ADMIN_URL', 'GRIMOIRE_DB_APP_PASSWORD', 'GRIMOIRE_DB_MIGRATOR_PASSWORD']) expect(result.output).toContain(name);
    expect(result.output).toContain('db_setup.config_invalid');
  });

  it('exits 1 when the administrator cannot connect, and no password is in the output', async () => {
    const result = await run({
      GRIMOIRE_DATABASE_ADMIN_URL: `postgresql://grimoire_admin:${ADMIN_PASSWORD}@127.0.0.1:55432/grimoire`,
      GRIMOIRE_DB_APP_PASSWORD: APP,
      GRIMOIRE_DB_MIGRATOR_PASSWORD: MIGRATOR,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('db_setup.failed');
    expect(leaks(result.output)).toEqual([]);
  });

  it('the server refuses to start holding the administrator connection or a role password', async () => {
    const result = await runToEnd([path.join(serverDir, 'dist/main.js')], {
      GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'dev-token-secret-0123456789', GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl('127.0.0.1:55432', 'grimoire', 'grimoire_app'), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      GRIMOIRE_DATABASE_ADMIN_URL: `postgresql://grimoire_admin:${ADMIN_PASSWORD}@127.0.0.1:55432/grimoire`,
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('GRIMOIRE_DATABASE_ADMIN_URL');
    expect(leaks(result.output)).toEqual([]);
  });
});
