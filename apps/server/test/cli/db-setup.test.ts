import { describe, expect, it } from 'vitest';
import { composeDbSetup } from '../../src/composition.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const env = {
  GRIMOIRE_DATABASE_ADMIN_URL: placeholderDatabaseUrl('127.0.0.1:55432', 'grimoire', 'admin'),
  GRIMOIRE_DB_APP_PASSWORD: 'app-password-0123456789',
  GRIMOIRE_DB_MIGRATOR_PASSWORD: 'migrator-password-0123456789',
  GRIMOIRE_DB_OPS_PASSWORD: 'ops-password-0123456789',
};

describe('the db-setup composition', () => {
  it('builds the administrator connection and carries the three passwords', async () => {
    const result = composeDbSetup({ env });
    // Packages reach each other through their built `dist/`: a `config-env` built before the `db-setup` purpose existed refuses these settings. The fix is `bun run build`.
    expect(result.ok, 'composeDbSetup refused valid settings: is packages/adapters/config-env/dist older than its source? Run `bun run build`').toBe(true);
    if (result.ok) {
      expect(result.ctx.passwords).toEqual({ app: env.GRIMOIRE_DB_APP_PASSWORD, migrator: env.GRIMOIRE_DB_MIGRATOR_PASSWORD, ops: env.GRIMOIRE_DB_OPS_PASSWORD });
      await result.ctx.db.close();
    }
  });

  it.each(['GRIMOIRE_DATABASE_ADMIN_URL', 'GRIMOIRE_DB_APP_PASSWORD', 'GRIMOIRE_DB_MIGRATOR_PASSWORD', 'GRIMOIRE_DB_OPS_PASSWORD'] as const)('refuses with code 2 when %s is missing', (name) => {
    const result = composeDbSetup({ env: Object.fromEntries(Object.entries(env).filter(([key]) => key !== name)) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  it('refuses a short password, and a bad environment altogether', () => {
    expect(composeDbSetup({ env: { ...env, GRIMOIRE_DB_APP_PASSWORD: 'short' } }).ok).toBe(false);
    expect(composeDbSetup({ env: { ...env, GRIMOIRE_DATABASE_ADMIN_URL: 'not a url' } }).ok).toBe(false);
  });
});
