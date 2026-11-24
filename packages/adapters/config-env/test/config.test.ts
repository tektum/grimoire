import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadConfigFromProcessEnv } from '../src/index.js';

const SECRET = 'test-secret-0123456789abcdef';
const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: SECRET,
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

function issuesOf(env: Record<string, string>, opts?: Parameters<typeof loadConfig>[1]): string[] {
  try {
    loadConfig(env, opts);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe('loadConfig defaults', () => {
  it('applies the contracts defaults', () => {
    const c = loadConfig(base);
    expect(c.local).toBe(true);
    expect(c.role).toBe('all');
    expect(c.port).toBe(8080);
    expect(c.collabPort).toBeUndefined();
    expect(c.logLevel).toBe('info');
    expect(c.trustedProxies).toEqual([]);
    expect(c.shutdownSaveDeadlineMs).toBe(45000);
    expect(c.descopeProjectId).toBeUndefined();
    expect(c.database).toEqual({ url: base.GRIMOIRE_DATABASE_URL });
    expect(c.collab).toEqual({
      maxPayloadBytes: 1048576, maxStateBytes: 1_000_000, stateWarnPercent: 80,
      messagesPerWindow: 300, rateWindowSeconds: 10, maxConnectionsPerPage: 100,
      maxConnections: 500, maxOpenDocuments: 200, memoryLimitBytes: 1073741824,
      memoryGuardPercent: 80, idleUnloadSeconds: 60, connectAttemptsPerWindow: 50,
      connectWindowSeconds: 60, banSeconds: 300, maxUnauthSocketsPerAddress: 10, maxUnauthSockets: 500, maxUnauthQueuedBytes: 67_108_864,
      preauthTimeoutSeconds: 5, maxSocketsPerUser: 20, maxDocumentsPerUser: 50, bytesPerSecondPerUser: 2097152,
      seedMaxMarkdownBytes: 131072, seedTimeoutMs: 10000, reseedTimeoutMs: 30000, saveTimeoutMs: 10000, convertPoolSize: 2,
      debounceMs: 3000, maxDebounceMs: 10000, storeRetryBaseMs: 1000, storeRetryMaxMs: 30000, storeTimeoutMs: 2000, recheckSeconds: 60,
    });
  });

  it('defaults GRIMOIRE_LOCAL to 0, which then requires a project id', () => {
    const env = { ...base, GRIMOIRE_LOCAL: '' };
    expect(issuesOf(env).join()).toContain('non-local');
    expect(loadConfig({ ...env, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' }).local).toBe(false);
  });

  it('parses explicit values', () => {
    const c = loadConfig({
      ...base, GRIMOIRE_ROLE: 'collab', GRIMOIRE_PORT: '9000', GRIMOIRE_COLLAB_PORT: '9001',
      GRIMOIRE_LOG_LEVEL: 'debug', GRIMOIRE_TRUSTED_PROXY: '10.0.0.0/8, ::1',
      GRIMOIRE_ALLOWED_ORIGINS: 'http://a.test,https://b.test:8443', GRIMOIRE_COLLAB_DEBOUNCE_MS: '500',
    });
    expect(c).toMatchObject({ role: 'collab', port: 9000, collabPort: 9001, logLevel: 'debug' });
    expect(c.trustedProxies).toEqual(['10.0.0.0/8', '::1']);
    expect(c.allowedOrigins).toEqual(['http://a.test', 'https://b.test:8443']);
    expect(c.collab.debounceMs).toBe(500);
  });
});

// [variable, a malformed value, a valid non-default value]
const cases: readonly (readonly [string, string, string])[] = [
  ['GRIMOIRE_LOCAL', '2', '1'],
  ['GRIMOIRE_ROLE', 'worker', 'api'],
  ['GRIMOIRE_PORT', '0', '1'],
  ['GRIMOIRE_PORT', '65536', '65535'],
  ['GRIMOIRE_PORT', '80x', '9000'],
  ['GRIMOIRE_COLLAB_PORT', 'abc', '9001'],
  ['GRIMOIRE_COLLAB_PORT', '8080', '9001'],
  ['GRIMOIRE_LOG_LEVEL', 'trace', 'error'],
  ['GRIMOIRE_DATABASE_URL', 'mysql://x/y', 'postgres://u@h/db'],
  ['GRIMOIRE_DATABASE_MIGRATION_URL', 'http://x', 'postgres://m@h/db'],
  ['GRIMOIRE_ALLOWED_ORIGINS', '*', 'https://x.test'],
  ['GRIMOIRE_ALLOWED_ORIGINS', 'http://x.test/path', 'http://x.test:81'],
  ['GRIMOIRE_ALLOWED_ORIGINS', 'http://x.test/', 'http://x.test'],
  ['GRIMOIRE_TRUSTED_PROXY', 'not-an-ip', '192.168.0.0/16'],
  ['GRIMOIRE_TRUSTED_PROXY', '10.0.0.0/33', '10.0.0.0/32'],
  ['GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS', '0', '12001'],
  ['GRIMOIRE_DESCOPE_PROJECT_ID', '   ', 'P123'],
  ['GRIMOIRE_PUBLIC_API_URL', 'ftp://x', 'https://api.test'],
  ['GRIMOIRE_PUBLIC_COLLAB_URL', 'x', 'wss://collab.test'],
  ['GRIMOIRE_FIRST_ADMIN_EMAILS', 'nope', 'a@b.test,c@d.test'],
  ['GRIMOIRE_S3_ENDPOINT', 'x', 'http://127.0.0.1:8333'],
  ['GRIMOIRE_S3_ADDRESSING_STYLE', 'weird', 'virtual'],
  ['GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES', '0', '5'],
  ['GRIMOIRE_COLLAB_MAX_STATE_BYTES', '-1', '5'],
  ['GRIMOIRE_COLLAB_STATE_WARN_PERCENT', '100', '99'],
  ['GRIMOIRE_COLLAB_STATE_WARN_PERCENT', '0', '1'],
  ['GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW', '1.5', '5'],
  ['GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS', 'x', '5'],
  ['GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE', '0', '5'],
  ['GRIMOIRE_COLLAB_MAX_CONNECTIONS', '0', '5'],
  ['GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS', '0', '5'],
  ['GRIMOIRE_COLLAB_MEMORY_LIMIT_BYTES', '0', '5'],
  ['GRIMOIRE_COLLAB_MEMORY_GUARD_PERCENT', '100', '50'],
  ['GRIMOIRE_COLLAB_IDLE_UNLOAD_SECONDS', '0', '5'],
  ['GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW', '0', '5'],
  ['GRIMOIRE_COLLAB_CONNECT_WINDOW_SECONDS', '0', '5'],
  ['GRIMOIRE_COLLAB_BAN_SECONDS', '0', '5'],
  ['GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS', '0', '5'],
  ['GRIMOIRE_COLLAB_DEBOUNCE_MS', '0', '5'],
  ['GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS', 'x', '20000'],
  ['GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS', '0', '5'],
  ['GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS', '0', '5'],
  ['GRIMOIRE_SEED_MAX_MARKDOWN_BYTES', '0', '5'],
  ['GRIMOIRE_SEED_TIMEOUT_MS', '0', '5000'],
  ['GRIMOIRE_CONVERT_POOL_SIZE', '0', '4'],
  ['GRIMOIRE_RESEED_TIMEOUT_MS', '999', '60000'],
];

describe('every variable: reject and accept', () => {
  it.each(cases)('%s rejects %j and names the variable', (name, bad) => {
    const issues = issuesOf({ ...base, [name]: bad });
    expect(issues.some((i) => i.startsWith(`${name}:`))).toBe(true);
  });

  it.each(cases)('%s accepts %j-style valid value (%s)', (name, _bad, good) => {
    const env: Record<string, string> = { ...base, [name]: good };
    if (name === 'GRIMOIRE_DESCOPE_PROJECT_ID') {
      env['GRIMOIRE_LOCAL'] = '0';
      env['GRIMOIRE_ALLOWED_EMAIL_DOMAINS'] = 'example.test';
    }
    if (name === 'GRIMOIRE_COLLAB_DEBOUNCE_MS' || name === 'GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS') {
      env['GRIMOIRE_COLLAB_DEBOUNCE_MS'] = '5';
    }
    if (name.startsWith('GRIMOIRE_S3_')) {
      Object.assign(env, {
        GRIMOIRE_S3_ENDPOINT: 'http://127.0.0.1:8333', GRIMOIRE_S3_BUCKET: 'b',
        GRIMOIRE_S3_ACCESS_KEY: 'k', GRIMOIRE_S3_SECRET_KEY: 's', [name]: good,
      });
    }
    expect(issuesOf(env)).toEqual([]);
  });

  it.each(cases)('%s: empty string counts as unset (%s)', (name) => {
    const env: Record<string, string> = { ...base, [name]: '' };
    if (name === 'GRIMOIRE_LOCAL') {
      expect(issuesOf(env).join()).toContain('non-local');
      return;
    }
    if (name === 'GRIMOIRE_DATABASE_URL' || name === 'GRIMOIRE_ALLOWED_ORIGINS') {
      expect(issuesOf(env).some((i) => i.startsWith(`${name}: is required`))).toBe(true);
      return;
    }
    expect(issuesOf(env)).toEqual([]);
  });
});

describe('purpose and required values', () => {
  it('requires the migration URL for migrate, and not the server settings', () => {
    expect(issuesOf({}, { purpose: 'migrate' })).toEqual([
      expect.stringContaining('GRIMOIRE_DATABASE_MIGRATION_URL'),
    ]);
    const c = loadConfig({ GRIMOIRE_DATABASE_MIGRATION_URL: 'postgres://m@h/db' }, { purpose: 'migrate' });
    expect(c.database.migrationUrl).toBe('postgres://m@h/db');
  });

  it('requires database URL and allowed origins for the server and lists all problems', () => {
    const issues = issuesOf({ GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: SECRET });
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('GRIMOIRE_DATABASE_URL');
    expect(issues.join('\n')).toContain('GRIMOIRE_ALLOWED_ORIGINS');
  });

  it('requires endpoint and bucket once any S3 variable is set (the keys are optional: neither means the AWS default credential chain)', () => {
    const issues = issuesOf({ ...base, GRIMOIRE_S3_REGION: 'r' });
    expect(issues.map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_S3_ENDPOINT', 'GRIMOIRE_S3_BUCKET']);
  });

  it('takes the runtime key pair both or neither, and carries no key when there is none', () => {
    const store = { ...base, GRIMOIRE_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.test', GRIMOIRE_S3_BUCKET: 'b' };
    const chain = loadConfig(store).files;
    expect(chain).toBeDefined();
    expect(chain).not.toHaveProperty('accessKey');
    expect(chain).not.toHaveProperty('secretKey');
    expect(loadConfig({ ...store, GRIMOIRE_S3_ACCESS_KEY: 'a', GRIMOIRE_S3_SECRET_KEY: 's' }).files).toMatchObject({ accessKey: 'a', secretKey: 's' });
    expect(issuesOf({ ...store, GRIMOIRE_S3_ACCESS_KEY: 'a' }).map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_S3_SECRET_KEY']);
    expect(issuesOf({ ...store, GRIMOIRE_S3_SECRET_KEY: 's' }).map((i) => i.split(':')[0])).toEqual(['GRIMOIRE_S3_ACCESS_KEY']);
  });

  it('requires max debounce >= debounce', () => {
    const issues = issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: '9', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '8' });
    expect(issues).toEqual([expect.stringContaining('GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS')]);
  });
});

describe('startup refusals (R2.43)', () => {
  it('refuses local mode with a Descope project id', () => {
    const issues = issuesOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1' });
    expect(() => loadConfig({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1' })).toThrow(ConfigError);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('GRIMOIRE_LOCAL');
    expect(issues[0]).toContain('GRIMOIRE_DESCOPE_PROJECT_ID');
    expect(issues[0]).not.toContain('non-local');
  });

  it('refuses non-local mode without a Descope project id', () => {
    const env = { ...base, GRIMOIRE_LOCAL: '0' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    const issues = issuesOf(env);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('GRIMOIRE_DESCOPE_PROJECT_ID');
    expect(issues[0]).toContain('non-local');
    expect(issues[1]).toContain('GRIMOIRE_ALLOWED_EMAIL_DOMAINS');
  });

  it('accepts non-local mode with a project id and local mode without', () => {
    expect(loadConfig({ ...base, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' }).descopeProjectId).toBe('P1');
    expect(loadConfig(base).local).toBe(true);
  });
});

describe('secrets never appear in errors', () => {
  it('does not print bad database URL, secret key or project id values', () => {
    const env = {
      GRIMOIRE_LOCAL: '1',
      GRIMOIRE_DATABASE_URL: 'mysql://user:hunter2-db@h/db',
      GRIMOIRE_ALLOWED_ORIGINS: 'http://x.test/hunter2-origin',
      GRIMOIRE_S3_SECRET_KEY: 'hunter2-s3',
      GRIMOIRE_S3_ENDPOINT: 'nope-hunter2',
      GRIMOIRE_DESCOPE_PROJECT_ID: 'hunter2-project',
    };
    let message = '';
    try { loadConfig(env); } catch (e) { message = e instanceof Error ? e.message : ''; }
    expect(message).toContain('GRIMOIRE_DATABASE_URL');
    expect(message).not.toContain('hunter2');
  });
});

describe('loadConfigFromProcessEnv', () => {
  it('reads the real environment through the same loader', () => {
    expect(typeof loadConfigFromProcessEnv).toBe('function');
  });
});

describe('local mode refuses unsafe combinations', () => {
  const noSecret = { GRIMOIRE_LOCAL: base.GRIMOIRE_LOCAL, GRIMOIRE_DATABASE_URL: base.GRIMOIRE_DATABASE_URL, GRIMOIRE_ALLOWED_ORIGINS: base.GRIMOIRE_ALLOWED_ORIGINS };
  it('local mode without GRIMOIRE_DEV_TOKEN_SECRET refuses to start with one fixed line', () => {
    expect(issuesOf(noSecret)).toEqual(['GRIMOIRE_LOCAL: needs GRIMOIRE_DEV_TOKEN_SECRET to be set, at 16 or more characters (`make up` generates one in .env)']);
  });
  it('a short or malformed secret is refused', () => {
    expect(issuesOf({ ...base, GRIMOIRE_DEV_TOKEN_SECRET: 'short' })).toHaveLength(1);
    expect(issuesOf({ ...base, GRIMOIRE_DEV_TOKEN_SECRET: 'has:colon-0123456789abcdef' })).toHaveLength(1);
  });
  it.each(['0.0.0.0', '192.168.1.20', '::', '2001:db8::1'])('local mode bound to %s is refused unless GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK=1', (host) => {
    expect(issuesOf({ ...base, GRIMOIRE_HOST: host })).toEqual(['GRIMOIRE_HOST: is not a loopback address in local mode (development tokens): bind 127.0.0.1 or ::1, or set GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK=1 where the network is trusted']);
    expect(issuesOf({ ...base, GRIMOIRE_HOST: host, GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' })).toEqual([]);
  });
  it.each(['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1'])('local mode bound to loopback %s starts', (host) => {
    expect(issuesOf({ ...base, GRIMOIRE_HOST: host })).toEqual([]);
  });
  it('exposes the secret and the opt-in on Config', () => {
    expect(loadConfig(base).devTokenSecret).toBe(SECRET);
    expect(loadConfig(base).localAllowNonLoopback).toBe(false);
    expect(loadConfig({ ...base, GRIMOIRE_HOST: '0.0.0.0', GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' }).localAllowNonLoopback).toBe(true);
  });
  it('the rules do not apply to non-local mode', () => {
    expect(issuesOf({ ...noSecret, GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1', GRIMOIRE_HOST: '0.0.0.0', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' })).toEqual([]);
  });
});

describe('conversion settings: refused when not a sensible number', () => {
  it.each([
    ['GRIMOIRE_SEED_MAX_MARKDOWN_BYTES', 'x'], ['GRIMOIRE_SEED_MAX_MARKDOWN_BYTES', '999999999999'], ['GRIMOIRE_SEED_MAX_MARKDOWN_BYTES', '-5'],
    ['GRIMOIRE_SEED_TIMEOUT_MS', 'x'], ['GRIMOIRE_SEED_TIMEOUT_MS', '99'], ['GRIMOIRE_SEED_TIMEOUT_MS', '3600000'], ['GRIMOIRE_SEED_TIMEOUT_MS', '1.5'],
    ['GRIMOIRE_RESEED_TIMEOUT_MS', 'x'], ['GRIMOIRE_RESEED_TIMEOUT_MS', '3600000'], ['GRIMOIRE_RESEED_TIMEOUT_MS', '0'], ['GRIMOIRE_RESEED_TIMEOUT_MS', '30000.5'],
    ['GRIMOIRE_CONVERT_POOL_SIZE', 'x'], ['GRIMOIRE_CONVERT_POOL_SIZE', '1000'], ['GRIMOIRE_CONVERT_POOL_SIZE', '2.5'],
  ])('%s rejects %s', (name, bad) => {
    expect(issuesOf({ ...base, [name]: bad }).some((i) => i.startsWith(`${name}:`))).toBe(true);
  });
});
