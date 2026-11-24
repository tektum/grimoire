import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(),
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
const names = (issues: string[]): string[] => issues.map((i) => i.split(':')[0] ?? '');

describe('cross rules never throw (invalid operand is reported, rule skipped)', () => {
  it.each(['abc', '0', '1e3', '65536', '-1'])('invalid GRIMOIRE_PORT %j with a valid collab port', (bad) => {
    const issues = issuesOf({ ...base, GRIMOIRE_PORT: bad, GRIMOIRE_COLLAB_PORT: '9001' });
    expect(names(issues)).toEqual(['GRIMOIRE_PORT']);
  });
  it('invalid debounce with a valid maximum', () => {
    expect(names(issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: 'x', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '5' })))
      .toEqual(['GRIMOIRE_COLLAB_DEBOUNCE_MS']);
  });
});

describe('boundaries of cross-field rules', () => {
  it('accepts debounce equal to maximum debounce', () => {
    expect(issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: '7', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '7' })).toEqual([]);
  });
  it('rejects debounce greater than maximum by one', () => {
    expect(names(issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: '8', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '7' })))
      .toEqual(['GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS']);
  });
  it('rejects collab port equal to the HTTP port', () => {
    expect(names(issuesOf({ ...base, GRIMOIRE_PORT: '9000', GRIMOIRE_COLLAB_PORT: '9000' }))).toEqual(['GRIMOIRE_COLLAB_PORT']);
  });
  it('accepts collab port different by one', () => {
    expect(issuesOf({ ...base, GRIMOIRE_PORT: '9000', GRIMOIRE_COLLAB_PORT: '9001' })).toEqual([]);
  });
});

describe('local mode with a Descope project id', () => {
  it('leads with GRIMOIRE_LOCAL and names both variables', () => {
    const [issue] = issuesOf({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: 'P1' });
    expect(issue?.startsWith('GRIMOIRE_LOCAL:')).toBe(true);
    expect(issue).toContain('GRIMOIRE_DESCOPE_PROJECT_ID');
  });
});

describe('email list is zod z.email on purpose (stricter than the old regex)', () => {
  it.each([
    ['unicode local part', 'jörg@example.test'],
    ['unicode domain', 'a@bücher.test'],
    ['quoted local part', '"a b"@example.test'],
    ['IP-literal domain', 'a@[1.2.3.4]'],
    ['one-letter top-level domain', 'a@b.c'],
    ['double dot', 'a..b@example.test'],
    ['leading dot', '.a@example.test'],
    ['trailing dot', 'a.@example.test'],
  ])('rejects %s', (_label, value) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_FIRST_ADMIN_EMAILS: value }))).toEqual(['GRIMOIRE_FIRST_ADMIN_EMAILS']);
  });
});

describe('trusted proxies follow zod ip/cidr rules', () => {
  it.each(['fe80::1%eth0', '1.1.1.1/024'])('rejects %s', (value) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_TRUSTED_PROXY: value }))).toEqual(['GRIMOIRE_TRUSTED_PROXY']);
  });
});

describe('URLs without // after the scheme', () => {
  it.each(['https:x.example', 'https:/x.example'])('rejects %s', (value) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_PUBLIC_API_URL: value }))).toEqual(['GRIMOIRE_PUBLIC_API_URL']);
    expect(names(issuesOf({ ...base, GRIMOIRE_S3_ENDPOINT: value, GRIMOIRE_S3_BUCKET: 'b', GRIMOIRE_S3_ACCESS_KEY: 'k', GRIMOIRE_S3_SECRET_KEY: 's' })))
      .toEqual(['GRIMOIRE_S3_ENDPOINT']);
  });
});

describe('every value is printable ASCII (0x21-0x7E); list items may have spaces around commas', () => {
  const rule = 'must contain only printable ASCII characters';
  const good: Record<string, string> = {
    GRIMOIRE_ROLE: 'api', GRIMOIRE_PORT: '9000', GRIMOIRE_COLLAB_PORT: '9001', GRIMOIRE_LOG_LEVEL: 'info',
    GRIMOIRE_DATABASE_MIGRATION_URL: 'postgres://m@h/db', GRIMOIRE_DESCOPE_PROJECT_ID: 'P1',
    GRIMOIRE_TRUSTED_PROXY: '10.0.0.0/8', GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '5', GRIMOIRE_COLLAB_DEBOUNCE_MS: '5',
    GRIMOIRE_PUBLIC_API_URL: 'https://a.test', GRIMOIRE_PUBLIC_COLLAB_URL: 'wss://c.test',
    GRIMOIRE_FIRST_ADMIN_EMAILS: 'a@b.test', GRIMOIRE_S3_REGION: 'r', GRIMOIRE_S3_ADDRESSING_STYLE: 'path',
    GRIMOIRE_S3_ENDPOINT: 'http://127.0.0.1:8333', GRIMOIRE_S3_PUBLIC_ENDPOINT: 'http://p.test',
    GRIMOIRE_S3_BUCKET: 'bucket', GRIMOIRE_S3_ACCESS_KEY: 'key', GRIMOIRE_S3_SECRET_KEY: 'secret',
    GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: '5', GRIMOIRE_COLLAB_STATE_WARN_PERCENT: '5',
    GRIMOIRE_DATABASE_URL: base.GRIMOIRE_DATABASE_URL, GRIMOIRE_ALLOWED_ORIGINS: base.GRIMOIRE_ALLOWED_ORIGINS,
    GRIMOIRE_LOCAL: '1',
  };
  const lists = ['GRIMOIRE_TRUSTED_PROXY', 'GRIMOIRE_FIRST_ADMIN_EMAILS', 'GRIMOIRE_ALLOWED_ORIGINS'];
  const mid = (v: string, ch: string): string => `${v.slice(0, 2)}${ch}${v.slice(2)}`;
  const wraps: [string, (v: string) => string][] = [
    ['U+200B at start', (v) => `\u200B${v}`], ['U+200B in the middle', (v) => mid(v, '\u200B')],
    ['U+200B at end', (v) => `${v}\u200B`], ['U+00A0', (v) => mid(v, '\u00A0')], ['U+2028', (v) => mid(v, '\u2028')],
    ['U+FEFF', (v) => `\uFEFF${v}`], ['an embedded space', (v) => mid(v, ' ')], ['a non-ASCII letter', (v) => mid(v, 'é')],
    ['trailing newline', (v) => `${v}\n`], ['carriage return', (v) => `${v}\r`], ['tab', (v) => `\t${v}`],
    ['NUL', (v) => `${v}\u0000`],
    ...[['leading space', (v: string) => ` ${v}`], ['trailing space', (v: string) => `${v} `]]
      .map((w): [string, (v: string) => string] => [w[0] as string, w[1] as (v: string) => string]),
  ];
  const cases = Object.keys(good).flatMap((name) => wraps
    .filter((w) => !(lists.includes(name) && /^(leading|trailing) space$/.test(w[0])))
    .map((w) => [name, w[0], w[1]] as const));
  it.each(cases)('%s with %s', (name, _label, wrap) => {
    const env = { ...base, ...good, GRIMOIRE_LOCAL: '0', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', [name]: wrap(good[name] ?? '') };
    const issues = issuesOf(name === 'GRIMOIRE_LOCAL' ? { ...env, GRIMOIRE_LOCAL: wrap('1') } : env);
    const mine = issues.filter((i) => i.startsWith(`${name}:`));
    expect(mine).toEqual([`${name}: ${rule}`]);
  });

  it.each(lists)('%s: spaces around commas are accepted', (name) => {
    const v = good[name] ?? '';
    expect(issuesOf({ ...base, [name]: ` ${v} , ${v}  ` })).toEqual([]);
  });
  it.each(lists)('%s: a space inside an item is rejected', (name) => {
    expect(issuesOf({ ...base, [name]: mid(good[name] ?? '', ' ') })).toEqual([`${name}: ${rule}`]);
  });
  it.each(lists)('%s: a tab or non-breaking space around a comma is rejected', (name) => {
    const v = good[name] ?? '';
    expect(issuesOf({ ...base, [name]: `${v},\t${v}` })).toEqual([`${name}: ${rule}`]);
    expect(issuesOf({ ...base, [name]: `${v}\u00A0,${v}` })).toEqual([`${name}: ${rule}`]);
  });

  it('rejects a database URL with a trailing newline or U+200B without echoing it', () => {
    for (const tail of ['\n', '\u200B']) {
      const issues = issuesOf({ ...base, GRIMOIRE_DATABASE_URL: `${base.GRIMOIRE_DATABASE_URL}${tail}` });
      expect(issues).toEqual([`GRIMOIRE_DATABASE_URL: ${rule}`]);
    }
  });
  it('still treats the empty string as unset', () => {
    expect(issuesOf({ ...base, GRIMOIRE_PUBLIC_API_URL: '' })).toEqual([]);
  });
});

describe('a cross-field rule runs only when every operand passed its own rule', () => {
  const bad = ['x', '0', '-1', '9007199254740992', '9007199254740993'];
  it.each(bad)('invalid debounce %j with a valid maximum: only the debounce is reported', (v) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: v, GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '5' })))
      .toEqual(['GRIMOIRE_COLLAB_DEBOUNCE_MS']);
  });
  it.each(bad)('invalid maximum debounce %j with a valid debounce: only the maximum is reported', (v) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_COLLAB_DEBOUNCE_MS: '5', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: v })))
      .toEqual(['GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS']);
  });
  const badPorts = ['x', '0', '-1', '65536', '9007199254740992'];
  it.each(badPorts)('invalid HTTP port %j with a valid collab port: only the HTTP port is reported', (v) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_PORT: v, GRIMOIRE_COLLAB_PORT: '65535' }))).toEqual(['GRIMOIRE_PORT']);
  });
  it.each(badPorts)('invalid collab port %j with a valid HTTP port: only the collab port is reported', (v) => {
    expect(names(issuesOf({ ...base, GRIMOIRE_PORT: '8080', GRIMOIRE_COLLAB_PORT: v }))).toEqual(['GRIMOIRE_COLLAB_PORT']);
  });
});

describe('seeded fuzz: only a Config or a ConfigError, and no secret in any issue', () => {
  const MARK = 'SECRETMARK';
  const pool: Record<string, string[]> = {
    GRIMOIRE_LOCAL: ['0', '1', '2', 'x'], GRIMOIRE_ROLE: ['all', 'api', 'collab', 'w'],
    GRIMOIRE_PORT: ['8080', '9000', '0', 'abc', '1e3', '65536'], GRIMOIRE_COLLAB_PORT: ['8080', '9000', '9001', 'abc', '0'],
    GRIMOIRE_LOG_LEVEL: ['info', 'debug', 'trace'],
    GRIMOIRE_DATABASE_URL: [placeholderDatabaseUrl('h', 'db').replace(/^postgresql:/, 'postgres:'), `mysql://u:${MARK}@h/db`, `postgres://u:${MARK}@[bad/db\n`, `postgres://u:${MARK}@h/db `],
    GRIMOIRE_DATABASE_MIGRATION_URL: ['postgres://m@h/db', `http://m:${MARK}@h`, `postgresql://m:${MARK}@h/\t`],
    GRIMOIRE_DESCOPE_PROJECT_ID: ['P1', '  ', 'P\u200B1', 'P 1', '\uFEFFP1', `${MARK}\n`],
    GRIMOIRE_ALLOWED_ORIGINS: ['http://a.test', 'http://a.test , https://b.test', `http://${MARK}\u200B.test`, `http://b\u00E9.test`, 'https://b.test:8443,http://c.test', `http://x.test/${MARK}`, '*', `http://${MARK}.test `],
    GRIMOIRE_TRUSTED_PROXY: ['10.0.0.0/8', '::1', 'fe80::1%eth0', `${MARK}`, '10.0.0.0/33'],
    GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: ['45000', '1', '0', 'x', '99999999999999999999'],
    GRIMOIRE_COLLAB_DEBOUNCE_MS: ['1', '5', '20000', '0', 'x'], GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: ['1', '5', '10000', '0', 'x'],
    GRIMOIRE_COLLAB_STATE_WARN_PERCENT: ['1', '99', '100'], GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: ['1', '0', '1.5'],
    GRIMOIRE_S3_ENDPOINT: ['http://s3.test', `ftp://k:${MARK}@s3.test`, `nope-${MARK}`, 'https:x.example'],
    GRIMOIRE_S3_PUBLIC_ENDPOINT: ['https://p.test', `x${MARK}`], GRIMOIRE_S3_BUCKET: ['b', ' ', `${MARK}\n`],
    GRIMOIRE_S3_ACCESS_KEY: ['k', `${MARK}\u0000`], GRIMOIRE_S3_SECRET_KEY: ['s', `s${MARK}\u00A0`, `${MARK}\u2028`, `  ${MARK}`, ' '],
    GRIMOIRE_S3_REGION: ['r', ' '], GRIMOIRE_S3_ADDRESSING_STYLE: ['path', 'virtual', 'weird'],
    GRIMOIRE_PUBLIC_API_URL: ['https://api.test', 'ftp://x', `https:/${MARK}`],
    GRIMOIRE_PUBLIC_COLLAB_URL: ['wss://c.test', `x${MARK}`],
    GRIMOIRE_FIRST_ADMIN_EMAILS: ['a@b.test', 'a@b.test, c@d.test', 'a@b\u200B.test', 'a\u00A0@b.test', `${MARK}`, `a..b@${MARK}.test`],
  };
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  it('survives 3000 random environments', () => {
    const rand = rng(123456789);
    let configs = 0;
    let errors = 0;
    for (let n = 0; n < 3000; n++) {
      const env: Record<string, string> = {};
      for (const [name, values] of Object.entries(pool)) {
        const r = rand();
        if (r < 0.3) continue;
        env[name] = r < 0.35 ? '' : (r < 0.8 ? values[0] : values[Math.floor(rand() * values.length)]) ?? '';
      }
      const purpose = rand() < 0.5 ? 'server' : 'migrate';
      try {
        loadConfig(env, { purpose });
        configs++;
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        errors++;
        if (e instanceof ConfigError) for (const issue of e.issues) expect(issue).not.toContain(MARK);
      }
    }
    expect(configs).toBeGreaterThan(0);
    expect(errors).toBeGreaterThan(0);
  }, 60_000); // 3000 parses took 4.8 s on a loaded machine and the default is 5 s
});
