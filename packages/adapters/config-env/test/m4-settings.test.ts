import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

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

describe('GRIMOIRE_REQUIRE_HANDSHAKE', () => {
  it('defaults to off', () => {
    expect(load().requireHandshake).toBe(false);
  });
  it.each([['0', false], ['1', true]])('reads %s as %s', (value, expected) => {
    expect(load({ GRIMOIRE_REQUIRE_HANDSHAKE: value }).requireHandshake).toBe(expected);
  });
  it.each(['true', 'yes', '2', '01'])('refuses %s and names the variable', (value) => {
    const issues = issuesOf({ GRIMOIRE_REQUIRE_HANDSHAKE: value });
    expect(issues).toEqual(['GRIMOIRE_REQUIRE_HANDSHAKE: must be 0 or 1']);
  });
});

describe('GRIMOIRE_MIN_CLIENT_VERSION', () => {
  it('defaults to 0.0.0', () => {
    expect(load().minClientVersion).toBe('0.0.0');
  });
  it('keeps a valid triple as written', () => {
    expect(load({ GRIMOIRE_MIN_CLIENT_VERSION: '1.20.3' }).minClientVersion).toBe('1.20.3');
  });
  it.each(['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '1.2.3-beta', '-1.2.3', '1.2.3 ', '1.02.0', '01.2.3', '1.2.03', '99999999999999999999.0.0'])('refuses %j and names the variable', (value) => {
    const issues = issuesOf({ GRIMOIRE_MIN_CLIENT_VERSION: value });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^GRIMOIRE_MIN_CLIENT_VERSION: /);
  });
});

describe.each([
  ['GRIMOIRE_HTTP_USER_LIMIT_PER_MINUTE', 'userLimitPerMinute', 1000],
  ['GRIMOIRE_HTTP_ADDRESS_LIMIT_PER_MINUTE', 'addressLimitPerMinute', 60],
  ['GRIMOIRE_HTTP_ADDRESS_CEILING_PER_MINUTE', 'addressCeilingPerMinute', 6000],
] as const)('%s', (variable, field, fallback) => {
  it(`defaults to ${String(fallback)}`, () => {
    expect(load().http[field]).toBe(fallback);
  });
  it('accepts a positive integer', () => {
    expect(load({ [variable]: '7' }).http[field]).toBe(7);
  });
  it.each(['0', '-1', '1.5', 'abc', '1e3'])('refuses %s and names the variable', (value) => {
    expect(issuesOf({ [variable]: value })).toEqual([`${variable}: must be an integer >= 1`]);
  });
});

describe('GRIMOIRE_PUBLIC_COLLAB_URL', () => {
  it('is kept in the config', () => {
    expect(load({ GRIMOIRE_PUBLIC_COLLAB_URL: 'wss://collab.example.test/collab' }).publicCollabUrl).toBe('wss://collab.example.test/collab');
  });
  it('is absent when unset', () => {
    expect(load()).not.toHaveProperty('publicCollabUrl');
  });
});
