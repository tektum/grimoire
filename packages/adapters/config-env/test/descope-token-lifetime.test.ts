import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

function issues(value: string): readonly string[] {
  try {
    loadConfig({ ...base, GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS: value });
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
}

describe('GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS', () => {
  it('defaults to the verifier default of 24 hours', () => {
    expect(loadConfig(base).descopeMaxTokenLifetimeSeconds).toBe(86400);
  });

  it.each(['1', '86400'])('accepts the inclusive bound %s', (value) => {
    expect(loadConfig({ ...base, GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS: value }).descopeMaxTokenLifetimeSeconds).toBe(Number(value));
  });

  it.each(['0', '86401', '86400.5', 'not-a-number'])('refuses malformed or out-of-range %j naming the variable', (value) => {
    expect(issues(value)).toEqual([expect.stringContaining('GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS')]);
  });
});
