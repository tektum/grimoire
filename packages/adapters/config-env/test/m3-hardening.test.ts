import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const KEY = 'fake-test-key-never-print-this';
const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

it.each([
  ['local with project ID', { GRIMOIRE_DESCOPE_PROJECT_ID: 'P1' }],
  ['non-local missing project ID', { GRIMOIRE_LOCAL: '0', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' }],
  ['non-local missing domain list', { GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1' }],
  ['local missing dev token secret', { GRIMOIRE_DEV_TOKEN_SECRET: undefined }],
  ['local non-loopback bind', { GRIMOIRE_HOST: '0.0.0.0' }],
  ['matching HTTP and collab port', { GRIMOIRE_COLLAB_PORT: '8080' }],
  ['max debounce shorter than debounce', { GRIMOIRE_COLLAB_DEBOUNCE_MS: '20', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '10' }],
  ['save timeout at deadline', { GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '45000' }],
  ['partial S3 settings', { GRIMOIRE_S3_REGION: 'test-region-1' }],
  ['malformed domain', { GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: '@example.test' }],
  ['malformed base URL', { GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_DESCOPE_BASE_URL: 'not-a-url' }],
  ['non-local HTTP base URL', { GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_DESCOPE_BASE_URL: 'http://keys.example.test' }],
  ['bad recheck range', { GRIMOIRE_COLLAB_RECHECK_SECONDS: '0' }],
  ['invalid S3 endpoint', { GRIMOIRE_S3_ENDPOINT: 'http://test.example', GRIMOIRE_S3_ACCESS_KEY: 'a fake key' }],
  ['base URL and management key without project ID', { GRIMOIRE_LOCAL: '0', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_DESCOPE_BASE_URL: 'https://keys.example.test' }],
])('management-key secrecy in every error path: %s', (_case, overrides) => {
  try {
    loadConfig({ ...base, ...overrides, GRIMOIRE_DESCOPE_MANAGEMENT_KEY: KEY });
    throw new Error('the test should force a config error path');
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    if (!(e instanceof ConfigError)) throw e;
    expect(e.message).not.toContain(KEY);
    expect(e.issues.join('\n')).not.toContain(KEY);
  }
});
it('rejects credentials in the base URL without printing a management key', () => {
  try {
    loadConfig({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_DESCOPE_BASE_URL: 'https://user:pass@example.test', GRIMOIRE_DESCOPE_MANAGEMENT_KEY: KEY });
    throw new Error('the test requires the credential-validation error');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    expect(e.issues.join('\n')).toContain('GRIMOIRE_DESCOPE_BASE_URL');
    expect(e.message).not.toContain(KEY);
    expect(e.issues.join('\n')).not.toContain(KEY);
  }
});


it('deduplicates domains and first-admin emails lowercased while keeping first occurrence order', () => {
  const c = loadConfig({
    ...base,
    GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'B.example.test,a.example.test,b.example.test,A.EXAMPLE.TEST',
    GRIMOIRE_FIRST_ADMIN_EMAILS: 'Bob@example.test,Alice@example.test,bob@example.test,ALICE@EXAMPLE.TEST',
  });
  expect(c.allowedEmailDomains).toEqual(['b.example.test', 'a.example.test']);
  expect(c.firstAdminEmails).toEqual(['bob@example.test', 'alice@example.test']);
});
