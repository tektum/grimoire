import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

function issue(env: Record<string, string>, opts?: Parameters<typeof loadConfig>[1]): string | undefined {
  try {
    loadConfig(env, opts);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues.find((i) => i.startsWith('GRIMOIRE_DESCOPE_BASE_URL:'));
  }
  return undefined;
}

const localCredentialUrl = (url: string) => issue({
  ...base, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1',
  GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_DESCOPE_BASE_URL: url,
});

const nonLocalBase = { ...base, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' };

it.each(['http://example.test', 'https://keys.example.test', 'http://127.0.0.1:9443'])('local mode accepts an uncredentialed URL: %s', (url) => {
  expect(issue({ ...base, GRIMOIRE_LOCAL: '1', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_DESCOPE_BASE_URL: url }, { purpose: 'migrate' })).toBeUndefined();
});

it.each(['https://user@example.test', 'https://user:pass@example.test'])('rejects URL credentials: %s', (url) => {
  const message = localCredentialUrl(url);
  expect(message).toBeDefined();
  expect(message).not.toContain(url);
});

it('accepts HTTPS and rejects HTTP outside local mode', () => {
  expect(issue({ ...nonLocalBase, GRIMOIRE_DESCOPE_BASE_URL: 'https://keys.example.test' })).toBeUndefined();
  const message = issue({ ...nonLocalBase, GRIMOIRE_DESCOPE_BASE_URL: 'http://keys.example.test' });
  expect(message).toContain('https');
  expect(message).not.toContain('http://keys.example.test');
});

it.each(['http://', 'https://:80', 'http://exa mple.test', 'not a url'])('a malformed base URL is reported as a problem, never thrown: %s', (url) => {
  expect(localCredentialUrl(url)).toMatch(/^GRIMOIRE_DESCOPE_BASE_URL:/);
});
