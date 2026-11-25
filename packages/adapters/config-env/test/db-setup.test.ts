import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const setupEnv = {
  GRIMOIRE_DATABASE_ADMIN_URL: placeholderDatabaseUrl('db.example.test:5432', 'grimoire', 'admin'),
  GRIMOIRE_DB_APP_PASSWORD: 'app-password-0123456789',
  GRIMOIRE_DB_MIGRATOR_PASSWORD: 'migrator-password-0123456789',
  GRIMOIRE_DB_OPS_PASSWORD: 'ops-password-0123456789',
};
const problems = (env: Record<string, string>, purpose: 'db-setup' | 'server' | 'migrate' = 'db-setup'): string[] => {
  try { loadConfig(env, { purpose }); return []; } catch (e) { if (e instanceof ConfigError) return e.problems.map((p) => `${p.setting}: ${p.rule}`); throw e; }
};

describe('the db-setup purpose', () => {
  it('carries the administrator connection and the three passwords, and needs nothing else (no server settings, no runtime URL)', () => {
    expect(loadConfig(setupEnv, { purpose: 'db-setup' }).dbSetup).toEqual({
      adminUrl: setupEnv.GRIMOIRE_DATABASE_ADMIN_URL, appPassword: setupEnv.GRIMOIRE_DB_APP_PASSWORD, migratorPassword: setupEnv.GRIMOIRE_DB_MIGRATOR_PASSWORD,
      opsPassword: setupEnv.GRIMOIRE_DB_OPS_PASSWORD,
    });
  });

  it('names each missing setting', () => {
    expect(problems({})).toEqual([
      'GRIMOIRE_DATABASE_ADMIN_URL: is required to run db-setup',
      'GRIMOIRE_DB_APP_PASSWORD: is required to run db-setup',
      'GRIMOIRE_DB_MIGRATOR_PASSWORD: is required to run db-setup',
      'GRIMOIRE_DB_OPS_PASSWORD: is required to run db-setup',
    ]);
  });

  it('refuses a password under 16 characters, without echoing it', () => {
    const found = problems({ ...setupEnv, GRIMOIRE_DB_APP_PASSWORD: 'short-secret' });
    expect(found).toEqual(['GRIMOIRE_DB_APP_PASSWORD: must be at least 16 characters']);
    expect(found.join()).not.toContain('short-secret');
  });

  it('is not part of the other purposes: the server and the migration never carry it', () => {
    expect(loadConfig({ ...setupEnv, GRIMOIRE_DATABASE_MIGRATION_URL: placeholderDatabaseUrl('h', 'grimoire', 'm') }, { purpose: 'migrate' }).dbSetup).toBeUndefined();
  });

  it.each(Object.keys(setupEnv))('the server refuses %s: only the db-setup step holds it', (name) => {
    const server = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'dev-token-secret-0123456789', GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl('h'), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
    const found = problems({ ...server, [name]: setupEnv[name as keyof typeof setupEnv] }, 'server');
    expect(found).toEqual([`${name}: must not be set for the server: only the db-setup step holds the administrator connection and the role passwords`]);
  });
});

describe('the operator connection (GRIMOIRE_DATABASE_OPS_URL)', () => {
  const server = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'dev-token-secret-0123456789', GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl('h'), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };

  it('is optional: without it the server has no operator connection', () => {
    expect(loadConfig(server, { purpose: 'server' }).database.opsUrl).toBeUndefined();
  });

  it('is carried when it is a postgres URL', () => {
    const opsUrl = placeholderDatabaseUrl('h', 'grimoire', 'grimoire_ops');
    expect(loadConfig({ ...server, GRIMOIRE_DATABASE_OPS_URL: opsUrl }, { purpose: 'server' }).database.opsUrl).toBe(opsUrl);
  });

  it('is named when it is not a postgres URL, without echoing its password', () => {
    const found = problems({ ...server, GRIMOIRE_DATABASE_OPS_URL: 'mysql://grimoire_ops:hidden-secret-value@h/grimoire' }, 'server');
    expect(found).toEqual(['GRIMOIRE_DATABASE_OPS_URL: must be a postgres:// or postgresql:// URL']);
    expect(found.join()).not.toContain('hidden-secret-value');
  });
});
