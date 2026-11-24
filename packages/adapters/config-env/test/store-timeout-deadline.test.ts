import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(),
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};
const issues = (env: Record<string, string>): string[] => {
  try { loadConfig({ ...base, ...env }); } catch (e) { if (e instanceof ConfigError) return e.issues; throw e; }
  return [];
};

describe('GRIMOIRE_COLLAB_STORE_TIMEOUT_MS must be smaller than GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS', () => {
  it('the defaults (2000 and 45000) pass', () => {
    expect(issues({})).toEqual([]);
  });
  it('one below the deadline passes; equal and above are refused, naming both variables', () => {
    expect(issues({ GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '2899', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '3000', GRIMOIRE_SAVE_TIMEOUT_MS: '100' })).toEqual([]);
    for (const timeout of ['3000', '3001']) {
      const found = issues({ GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: timeout, GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '3000', GRIMOIRE_SAVE_TIMEOUT_MS: '100' });
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('GRIMOIRE_COLLAB_STORE_TIMEOUT_MS');
      expect(found[0]).toContain('GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS');
    }
  });
  it('a default timeout above a small deadline is refused too', () => {
    expect(issues({ GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '1500', GRIMOIRE_SAVE_TIMEOUT_MS: '100' })).toHaveLength(1);
  });
  it('runs only when both operands are valid: a bad operand is reported by its own variable alone', () => {
    const bad = issues({ GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: 'abc', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '1500', GRIMOIRE_SAVE_TIMEOUT_MS: '100' });
    expect(bad.map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_COLLAB_STORE_TIMEOUT_MS']);
    const bad2 = issues({ GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '5000', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '0' });
    expect(bad2.map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS']);
  });
});
