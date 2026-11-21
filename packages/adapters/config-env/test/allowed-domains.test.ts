import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
};

function issuesOf(local: '0' | undefined, domains: string | undefined): string[] {
  try {
    loadConfig({ ...base, GRIMOIRE_LOCAL: local, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: domains });
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe('production allowed email domains cannot mean any domain', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('GRIMOIRE_LOCAL unset and domains %s', (_state, domains) => {
    expect(issuesOf(undefined, domains)).toEqual([
      expect.stringContaining('GRIMOIRE_ALLOWED_EMAIL_DOMAINS'),
    ]);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('GRIMOIRE_LOCAL=0 and domains %s', (_state, domains) => {
    expect(issuesOf('0', domains)).toEqual([
      expect.stringContaining('GRIMOIRE_ALLOWED_EMAIL_DOMAINS'),
    ]);
  });

  it('accepts empty domains with GRIMOIRE_LOCAL=1', () => {
    expect(loadConfig({ ...base, GRIMOIRE_LOCAL: '1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: '' }).allowedEmailDomains).toEqual([]);
  });

  it('does not require domains for migrations', () => {
    expect(loadConfig({
      GRIMOIRE_DATABASE_MIGRATION_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
    }, { purpose: 'migrate' }).allowedEmailDomains).toEqual([]);
  });
});
