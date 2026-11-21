import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};
const issuesOf = (env: Record<string, string>): string[] => {
  try { loadConfig(env); } catch (e) { if (e instanceof ConfigError) return e.issues; throw e; }
  return [];
};

describe('GRIMOIRE_HOST', () => {
  it('defaults to the IPv4 loopback address when unset or empty', () => {
    expect(loadConfig(base).host).toBe('127.0.0.1');
    expect(loadConfig({ ...base, GRIMOIRE_HOST: '' }).host).toBe('127.0.0.1');
  });

  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '::1', '::', '2001:db8::1'])('accepts the literal %s', (host) => {
    // Non-loopback literals are valid hosts; local mode additionally needs the explicit opt-in (config.test.ts, F2).
    expect(loadConfig({ ...base, GRIMOIRE_HOST: host, GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' }).host).toBe(host);
  });

  it.each(['localhost', 'example.test', '999.1.1.1', '127.0.0.1:8080', '[::1]:8080', '[::1]', '1.2.3', '1.2.3.4/8', 'fe80::1%eth0', '0x7f.1', '127.0.0.１', 'ab\u200Bc', '127.0.0.1 '])(
    'refuses %j, naming only the variable and never echoing the value',
    (host) => {
      const issues = issuesOf({ ...base, GRIMOIRE_HOST: host });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^GRIMOIRE_HOST: /);
      expect(issues[0]).not.toContain(host.trim() || 'x');
    },
  );

  it('refuses a space-only value as printable-ASCII violation, not as unset', () => {
    expect(issuesOf({ ...base, GRIMOIRE_HOST: '  ' })[0]).toMatch(/^GRIMOIRE_HOST: .*printable ASCII/);
  });

  it('does not mask other issues and is reported alongside them', () => {
    const issues = issuesOf({ ...base, GRIMOIRE_HOST: 'localhost', GRIMOIRE_PORT: '0' });
    expect(issues.map((i) => i.split(':')[0]).sort()).toEqual(['GRIMOIRE_HOST', 'GRIMOIRE_PORT']);
  });
});
