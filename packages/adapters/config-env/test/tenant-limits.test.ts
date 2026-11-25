import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

// docs/tenancy.md section 3.8: the caps of one tenant, each from a setting with a default.
const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: randomBytes(24).toString('hex'), // generated per run: no secret-looking literal in the repository
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(),
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra });

function issuesOf(extra: Record<string, string>): string[] {
  try {
    load(extra);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe.each([
  ['GRIMOIRE_TENANT_MAX_USERS', 'maxUsers', 1000],
  ['GRIMOIRE_TENANT_MAX_STORAGE_BYTES', 'maxStorageBytes', 10 * 1024 ** 3],
  ['GRIMOIRE_TENANT_MAX_PAGES', 'maxPages', 50_000],
] as const)('%s', (variable, field, fallback) => {
  it(`defaults to ${String(fallback)}`, () => {
    expect(load().tenantLimits[field]).toBe(fallback);
  });
  it('accepts 1, the lower bound, and a larger integer', () => {
    expect(load({ [variable]: '1' }).tenantLimits[field]).toBe(1);
    expect(load({ [variable]: '20000000000' }).tenantLimits[field]).toBe(20_000_000_000);
  });
  it.each(['0', '-1', '1.5', 'abc', '1e3', '99999999999999999999'])('refuses %s and names the variable', (value) => {
    expect(issuesOf({ [variable]: value })).toEqual([`${variable}: must be an integer >= 1`]);
  });
});
