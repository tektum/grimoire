import { describe, expect, it } from 'vitest';
import type { Config } from '@tektum/grimoire-core/ports/config';
import { ConfigError, loadConfig } from '../src/index.js';

const SECRET = 'test-secret-0123456789abcdef';
const local = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: SECRET,
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

function field(config: Config, name: string): unknown {
  switch (name) {
    case 'GRIMOIRE_FIRST_ADMIN_EMAILS': return config.firstAdminEmails;
    case 'GRIMOIRE_ALLOWED_EMAIL_DOMAINS': return config.allowedEmailDomains;
    case 'GRIMOIRE_DESCOPE_BASE_URL': return config.descopeBaseUrl;
    case 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY': return config.descopeManagementKey;
    case 'GRIMOIRE_COLLAB_RECHECK_SECONDS': return config.collab.recheckSeconds;
    default: throw new Error('test table field name is not covered');
  }
}

const settings = [
  { name: 'GRIMOIRE_FIRST_ADMIN_EMAILS', bad: 'not-an-email', valid: 'ALICE@Example.TEST, Bob@Example.TEST', default: [], expected: ['alice@example.test', 'bob@example.test'] },
  { name: 'GRIMOIRE_ALLOWED_EMAIL_DOMAINS', bad: '@example.test', valid: 'Example.TEST, Example.ORG', default: [], expected: ['example.test', 'example.org'] },
  { name: 'GRIMOIRE_DESCOPE_BASE_URL', bad: 'ftp://keys.example.test', valid: 'https://keys.example.test', default: undefined, expected: 'https://keys.example.test' },
  { name: 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY', bad: '   ', valid: 'fake-test-management-key', default: undefined, expected: 'fake-test-management-key' },
  { name: 'GRIMOIRE_COLLAB_RECHECK_SECONDS', bad: 'seconds', valid: '120', default: 60, expected: 120 },
] as const;

describe.each(settings)('$name', ({ name, bad, valid, default: expectedDefault, expected }) => {
  it('returns the contract default when unset', () => {
    expect(field(loadConfig(local), name)).toEqual(expectedDefault);
  });

  it('rejects a malformed value with a ConfigError naming the variable', () => {
    const env = name === 'GRIMOIRE_DESCOPE_BASE_URL' || name === 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY'
      ? { ...local, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', [name]: bad } : { ...local, [name]: bad };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(issuesOf(env)).toEqual([
      expect.stringContaining(name),
    ]);
  });

  it('counts an empty string as unset', () => {
    expect(field(loadConfig({ ...local, [name]: '' }), name)).toEqual(expectedDefault);
  });

  it('returns the validated value', () => {
    const env = name === 'GRIMOIRE_DESCOPE_BASE_URL' || name === 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY'
      ? { ...local, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', [name]: valid } : { ...local, [name]: valid };
    expect(field(loadConfig(env), name)).toEqual(expected);
  });
});

describe('Descope settings dependencies', () => {
  it.each(['GRIMOIRE_DESCOPE_BASE_URL', 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY'])('%s requires the project id and names both variables', (name) => {
    const issues = issuesOf({
      ...local, GRIMOIRE_LOCAL: '0', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test',
      [name]: 'https://keys.example.test',
    });
    expect(issues.join('\n')).toContain('GRIMOIRE_DESCOPE_PROJECT_ID');
    expect(issues.join('\n')).toContain(name);
  });

  it.each(['0', '601'])('rejects GRIMOIRE_COLLAB_RECHECK_SECONDS=%s outside 1 to 600', (value) => {
    expect(issuesOf({ ...local, GRIMOIRE_COLLAB_RECHECK_SECONDS: value })).toEqual([
      expect.stringContaining('GRIMOIRE_COLLAB_RECHECK_SECONDS'),
    ]);
  });

  it('never includes management key text in ConfigError messages', () => {
    const key = 'fake-test-management-key-never-print-this';
    try {
      loadConfig({ ...local, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_DESCOPE_MANAGEMENT_KEY: key, GRIMOIRE_DESCOPE_BASE_URL: '   ' });
      throw new Error('expected config validation to fail');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      if (!(e instanceof ConfigError)) throw e;
      expect(e.message).not.toContain(key);
      expect(e.issues.join('\n')).not.toContain(key);
    }
  });
});
