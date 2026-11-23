import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@tektum/grimoire-adapter-config-env';

const key = () => randomBytes(12).toString('hex'); // generated per run: no secret-looking literal in the repository
const env = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: key() + key(),
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_S3_ENDPOINT: 'http://127.0.0.1:8333',
  GRIMOIRE_S3_BUCKET: 'grimoire',
  GRIMOIRE_S3_ACCESS_KEY: key(),
  GRIMOIRE_S3_SECRET_KEY: key(),
};
const issuesOf = (extra: Record<string, string>): string[] => {
  try {
    loadConfig({ ...env, ...extra });
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

describe('GRIMOIRE_S3_CREATE_ONLY_HEADER', () => {
  it('defaults to if-none-match', () => {
    expect(loadConfig(env).files?.createOnlyHeader).toBe('if-none-match');
  });
  it.each(['if-none-match', 'x-goog-if-generation-match'])('accepts %s', (value) => {
    expect(loadConfig({ ...env, GRIMOIRE_S3_CREATE_ONLY_HEADER: value }).files?.createOnlyHeader).toBe(value);
  });
  it.each(['if-match', 'If-None-Match', 'none'])('refuses %s, naming the variable', (value) => {
    expect(issuesOf({ GRIMOIRE_S3_CREATE_ONLY_HEADER: value }).join('\n')).toContain('GRIMOIRE_S3_CREATE_ONLY_HEADER');
  });
});

describe('GRIMOIRE_S3_CORS_MODE', () => {
  it('defaults to api', () => {
    expect(loadConfig(env).files?.corsMode).toBe('api');
  });
  it.each(['api', 'external'])('accepts %s', (value) => {
    expect(loadConfig({ ...env, GRIMOIRE_S3_CORS_MODE: value }).files?.corsMode).toBe(value);
  });
  it.each(['both', 'API', 'off'])('refuses %s, naming the variable', (value) => {
    expect(issuesOf({ GRIMOIRE_S3_CORS_MODE: value }).join('\n')).toContain('GRIMOIRE_S3_CORS_MODE');
  });
});
