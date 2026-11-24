import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
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

describe('GRIMOIRE_SAVE_TIMEOUT_MS (the time one save conversion may take)', () => {
  it('defaults to 10 seconds and reaches the collaboration settings', () => {
    expect(loadConfig({ ...base }).collab.saveTimeoutMs).toBe(10_000);
    expect(loadConfig({ ...base, GRIMOIRE_SAVE_TIMEOUT_MS: '15000' }).collab.saveTimeoutMs).toBe(15_000);
  });
  it.each(['x', '', '0', '99', '120001', '3600000', '-5', '1.5', '10000.5'])('refuses %j', (bad) => {
    const found = issues({ GRIMOIRE_SAVE_TIMEOUT_MS: bad });
    // an empty value means "not set" in this loader; everything else is refused by name
    if (bad === '') expect(found).toEqual([]);
    else expect(found.some((i) => i.startsWith('GRIMOIRE_SAVE_TIMEOUT_MS:'))).toBe(true);
  });
  it('a save is a conversion plus a store: both at their limits must end inside the shutdown save deadline, and the message names the three settings', () => {
    // default store timeout 2000: 10000 + 2000 < 12001
    expect(issues({ GRIMOIRE_SAVE_TIMEOUT_MS: '10000', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '12001' })).toEqual([]);
    for (const deadline of ['12000', '11000']) {
      const found = issues({ GRIMOIRE_SAVE_TIMEOUT_MS: '10000', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: deadline });
      expect(found, deadline).toHaveLength(1);
      expect(found[0]).toContain('GRIMOIRE_SAVE_TIMEOUT_MS');
      expect(found[0]).toContain('GRIMOIRE_COLLAB_STORE_TIMEOUT_MS');
      expect(found[0]).toContain('GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS');
    }
    // the example of the review: save 44,000, store 2,000, deadline 45,000 is refused
    expect(issues({ GRIMOIRE_SAVE_TIMEOUT_MS: '44000', GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '2000', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '45000' })).toHaveLength(1);
    // a store timeout that is itself not below the deadline is reported once, by its own rule
    expect(issues({ GRIMOIRE_SAVE_TIMEOUT_MS: '100', GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '3000', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '3000' }).map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_COLLAB_STORE_TIMEOUT_MS']);
  });
  it('the page-size default is 1,000,000 bytes', () => {
    expect(loadConfig({ ...base }).collab.maxStateBytes).toBe(1_000_000);
  });
});

describe('the fake configuration that tests build on follows the loader defaults for the page and conversion limits', () => {
  it.each(['maxStateBytes', 'saveTimeoutMs', 'seedMaxMarkdownBytes', 'seedTimeoutMs', 'reseedTimeoutMs'] as const)('%s', (key) => {
    expect(makeFakeConfig().collab[key]).toBe(loadConfig({ ...base }).collab[key]);
  });
});
