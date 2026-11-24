import { describe, expect, it } from 'vitest';
import { composeTenantAdopt } from '../../src/composition.js';
import { parseTenantAdoptArgs } from '../../src/lifecycle/tenant-adopt.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

describe('the arguments of grimoire tenant-adopt', () => {
  it('reads the two tenants, and the name and domain when given', () => {
    expect(parseTenantAdoptArgs(['--from', 'legacy', '--to', 'T-1'])).toEqual({ from: 'legacy', to: 'T-1' });
    expect(parseTenantAdoptArgs(['--to', 'T-1', '--from', 'legacy', '--name', 'Acme', '--domain', 'acme.example'])).toEqual({ from: 'legacy', to: 'T-1', name: 'Acme', domain: 'acme.example' });
    expect(parseTenantAdoptArgs(['--from=legacy', '--to=T-1', '--name=Acme Corp'])).toEqual({ from: 'legacy', to: 'T-1', name: 'Acme Corp' });
  });

  it.each([
    ['no arguments', []],
    ['no --to', ['--from', 'legacy']],
    ['no --from', ['--to', 'T-1']],
    ['a missing value', ['--from', 'legacy', '--to']],
    ['an unknown option', ['--from', 'legacy', '--to', 'T-1', '--force']],
    ['a positional argument', ['--from', 'legacy', '--to', 'T-1', 'extra']],
  ])('is a usage error with %s', (_name, args) => {
    expect(parseTenantAdoptArgs(args)).toBeUndefined();
  });
});

describe('the tenant-adopt composition', () => {
  it('connects as the migrator', async () => {
    const result = composeTenantAdopt({ env: { GRIMOIRE_DATABASE_MIGRATION_URL: placeholderDatabaseUrl('127.0.0.1:55432', 'grimoire', 'grimoire_migrator') } });
    expect(result.ok).toBe(true);
    if (result.ok) await result.ctx.db.close();
  });

  it('refuses with code 2 without the migrator connection, or with a bad one', () => {
    for (const env of [{}, { GRIMOIRE_DATABASE_MIGRATION_URL: 'not a url' }]) {
      const result = composeTenantAdopt({ env });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(2);
    }
  });
});
