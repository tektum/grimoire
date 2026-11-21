import { describe, expect, it } from 'vitest';
import type { CollabConfig } from '@tektum/grimoire-core/ports/config';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

type NumericSetting = {
  readonly env: string;
  readonly config: keyof CollabConfig;
  readonly defaultValue: number;
  readonly minimum?: number;
  readonly maximum?: number;
};

const settings: readonly NumericSetting[] = [
  { env: 'GRIMOIRE_COLLAB_MAX_SOCKETS_PER_USER', config: 'maxSocketsPerUser', defaultValue: 20 },
  { env: 'GRIMOIRE_COLLAB_MAX_DOCUMENTS_PER_USER', config: 'maxDocumentsPerUser', defaultValue: 50 },
  { env: 'GRIMOIRE_COLLAB_BYTES_PER_SECOND_PER_USER', config: 'bytesPerSecondPerUser', defaultValue: 2 * 1024 * 1024 },
  { env: 'GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS', config: 'preauthTimeoutSeconds', defaultValue: 5, minimum: 1, maximum: 60 },
];

describe.each(settings)('$env', ({ env, config, defaultValue, minimum = 1, maximum }) => {
  it('uses the specified default', () => {
    expect(loadConfig(base).collab[config]).toBe(defaultValue);
  });

  it('accepts the inclusive lower bound and a valid override', () => {
    expect(loadConfig({ ...base, [env]: String(minimum) }).collab[config]).toBe(minimum);
    expect(loadConfig({ ...base, [env]: String(minimum + 1) }).collab[config]).toBe(minimum + 1);
  });

  if (maximum !== undefined) {
    it('accepts the inclusive upper bound', () => {
      expect(loadConfig({ ...base, [env]: String(maximum) }).collab[config]).toBe(maximum);
    });
  }

  it.each(['0', ...(maximum === undefined ? [] : [String(maximum + 1)]), '1.5', 'not-a-number'])('refuses %j naming the variable', (value) => {
    try {
      loadConfig({ ...base, [env]: value });
      expect.unreachable('invalid setting was accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues).toEqual([expect.stringContaining(env)]);
    }
  });
});
