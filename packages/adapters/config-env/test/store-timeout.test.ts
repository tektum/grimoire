import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

describe('GRIMOIRE_COLLAB_STORE_TIMEOUT_MS', () => {
  it('defaults to 2000 ms', () => {
    expect(loadConfig(base).collab.storeTimeoutMs).toBe(2000);
  });
  it('takes an override', () => {
    expect(loadConfig({ ...base, GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '750' }).collab.storeTimeoutMs).toBe(750);
  });
  it.each(['0', '-1', 'abc', '1.5'])('refuses %j', (bad) => {
    try {
      loadConfig({ ...base, GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: bad });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_COLLAB_STORE_TIMEOUT_MS']);
    }
  });
});
