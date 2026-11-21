import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../src/index.js';

const S = 'LEAKME';

function run(fields: Record<string, unknown>, clockNow: () => number = () => 0, event = 'ev'): string[] {
  const lines: string[] = [];
  const log = createJsonLogger({ level: 'debug', destination: { write: (l) => lines.push(l.trimEnd()) }, clock: { now: clockNow } });
  log.info(event, fields);
  return lines;
}

function expectSafe(lines: string[], marker = S): void {
  expect(lines).toHaveLength(1);
  const line = lines[0] ?? '';
  expect(line).not.toContain(marker);
  expect(line).not.toContain('\n');
  const o = JSON.parse(line) as Record<string, unknown>;
  expect(['ts', 'level', 'event'].every((k) => k in o)).toBe(true);
}

const stringCases: readonly (readonly [string, string])[] = [
  ['url with bare query', `https://h/p?${S}`],
  ['host/path with bare query', `h.com/p?${S}`],
  ['password containing @', `postgres://u:p@ss${S}@h/db`],
  ['password containing /', `postgres://u:p/${S}@h/db`],
  ['password containing :', `postgres://u:a:${S}@h/db`],
  ['password containing ?', `postgres://u:a?${S}@h/db`],
  ['password containing #', `postgres://u:a#${S}@h/db`],
  ['password containing spaces', `postgres://u:a ${S} b@h/db`],
  ['userinfo without password', `https://${S}@h/db`],
  ['connection text Password=', `Server=h;Password=${S}`],
  ['Password= upper case spaced', `Server=h; PASSWORD = ${S};Db=x`],
  ['pwd=', `host=h;pwd=${S}`],
  ['secret=', `secret=${S}`],
  ['token=', `a=1;token=${S}`],
  ['apikey=', `apikey=${S}`],
  ['api_key:', `API_KEY: ${S}`],
  ['Authorization Bearer', `Authorization: Bearer ${S}`],
  ['authorization lower no spaces', `authorization:bearer ${S}`],
  ['Basic header', `Authorization: Basic ${S}`],
  ['bare Basic', `sent Basic ${S} to server`],
  ['bare bearer opaque', `got bearer ${S}${S}${S}`],
  ['JWT', `eyJ${S}.eyJ${S}.sig${S}`],
  ['JWT in sentence', `token was eyJhbGci.eyJ${S}.abc end`],
  ['fragment', `https://h/p#${S}`],
  ['fragment on path', `/cb#access_${S}`],
  ['query with ? only in value', `GET /p?a=b?${S} failed`],
  ['query without =', `/p?${S}`],
  ['query with spaces after URL', `https://h/p?a=1 ${S}`],
  ['sentence with url query', `see http://h/a?x=${S}&y=1 ok`],
  ['Set-Cookie text', `Set-Cookie: session=${S}; Path=/`],
];

describe('string redaction fails closed', () => {
  it.each(stringCases)('%s', (_name, value) => {
    expectSafe(run({ v: value }));
    expectSafe(run({ deep: { list: [value, { x: [value] }] } }));
    expectSafe(run({}, () => 0, `ev ${value}`));
    expectSafe(run({ err: new Error(`failed: ${value}`) }));
    expectSafe(run({ err: new Error('outer', { cause: new Error(value) }) }));
  });

  it('removes secrets from error stacks', () => {
    const e = new Error('x');
    e.stack = `Error: x\n    at connect (postgres://u:${S}@h/db)`;
    expectSafe(run({ e }));
  });

  it('keeps harmless text', () => {
    const line = run({ page: 'p1', note: 'saved 5 bytes' })[0] ?? '';
    expect(line).toContain('saved 5 bytes');
  });
});

const keyNames = [
  'token', 'Token', 'TOKEN', 'authToken', 'x-auth-token', 'password', 'Password', 'passwd', 'pwd', 'secret',
  'client_secret', 'authorization', 'Authorization', 'cookie', 'set-cookie', 'Set_Cookie', 'apikey', 'apiKey',
  'api_key', 'api-key', 'access_key', 'accessKey', 'secret_key', 'session', 'sessionId', 'credential', 'credentials',
];

describe('secret-named keys', () => {
  it.each(keyNames)('redacts the value of %s at any depth', (key) => {
    for (const value of [S, { inner: S }, [S], 42 as unknown]) {
      const marker = typeof value === 'number' ? '42' : S;
      expectSafe(run({ [key]: value }), marker);
      expectSafe(run({ a: { b: [{ [key]: value }] } }), marker);
    }
  });
});

describe('the logger never throws', () => {
  const cases: readonly (readonly [string, () => Record<string, unknown>, () => number])[] = [
    ['throwing getter', () => ({ get g(): string { throw new Error('boom'); } }), () => 0],
    ['proxy ownKeys throws', () => ({ p: new Proxy({}, { ownKeys() { throw new Error('p'); } }) }), () => 0],
    ['proxy get throws', () => ({ p: new Proxy({ a: 1 }, { get() { throw new Error('p'); } }) }), () => 0],
    ['top-level proxy', () => new Proxy({}, { ownKeys() { throw new Error('p'); } }), () => 0],
    ['clock NaN', () => ({ a: 1 }), () => NaN],
    ['clock Infinity', () => ({ a: 1 }), () => Infinity],
    ['clock throws', () => ({ a: 1 }), () => { throw new Error('c'); }],
    ['toJSON throws', () => ({ t: { toJSON() { throw new Error('t'); } } }), () => 0],
    ['symbol keys and values', () => ({ [Symbol('s')]: 1, v: Symbol('x') }), () => 0],
    ['functions', () => ({ f: () => 1 }), () => 0],
    ['bigint', () => ({ b: 10n }), () => 0],
    ['circular', () => { const c: Record<string, unknown> = {}; c['c'] = c; return c; }, () => 0],
    ['invalid date', () => ({ d: new Date(NaN) }), () => 0],
  ];
  it.each(cases)('%s', (_n, make, now) => {
    const lines = run(make(), now);
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(Number.isNaN(Date.parse(String(o['ts'])))).toBe(false);
    expect(o['level']).toBe('info');
    expect(o['event']).toBe('ev');
  });

  it('writes placeholders for unserialisable parts', () => {
    const o = JSON.parse(run({ f: () => 1, get g(): string { throw new Error('x'); } })[0] ?? '') as Record<string, unknown>;
    expect(o['f']).toBe('[unserialisable]');
    expect(o['g']).toBe('[unserialisable]');
  });

  it('does not throw when the writer throws', () => {
    const log = createJsonLogger({ destination: { write: () => { throw new Error('w'); } } });
    expect(() => log.error('e')).not.toThrow();
  });

  it('logs dates as ISO strings and Map and Set as data', () => {
    const o = JSON.parse(run({ d: new Date(0), m: new Map([['a', 1]]), s: new Set([1, 2]) })[0] ?? '') as Record<string, unknown>;
    expect(o['d']).toBe('1970-01-01T00:00:00.000Z');
    expect(o['m']).toEqual({ a: 1 });
    expect(o['s']).toEqual([1, 2]);
  });

  it('redacts secret-named Map keys', () => {
    expectSafe(run({ m: new Map([['password', S]]) }));
  });
});

describe('property: a random marker never survives', () => {
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const marker = (): string => `MK${rnd(1e9).toString(36)}${rnd(1e9).toString(36)}Z`;
  const pwChars = ['@', '/', ':', '?', '#', ' ', 'a', 'B', '9', '!', ';', '='];
  const pw = (m: string): string => {
    const parts = [m];
    for (let i = rnd(4); i > 0; i--) parts.push(pick(pwChars));
    return parts.join('');
  };
  const secretKeys = ['token', 'Password', 'x-api-key', 'client_secret', 'Set-Cookie', 'sessionId', 'Authorization', 'token2', '2password', 'key_7', 'otp3'];

  const stringWith = (m: string): string =>
    pick<() => string>([
      () => `${pick(['http', 'https', 'postgres', 'wss'])}://u:${pw(m)}@h:5/db`,
      () => `${pick(['https://h/p', 'h.com/x', '/rel'])}?${pick(['', 'a=', 'token='])}${m}${pick(['', '&y=1'])}`,
      () => `https://h/p#${m}`,
      () => `Server=h;${pick(['Password', 'pwd', 'SECRET', 'Token', 'ApiKey'])}${pick(['=', ' = ', ': '])}${m};x=1`,
      () => `Authorization: ${pick(['Bearer', 'Basic', 'bearer'])} ${m}`,
      () => `eyJ${m}.eyJ${m}.${m}`,
    ])();

  const nested = (m: string, depth: number): unknown => {
    if (depth === 0) return pick<() => unknown>([
      () => stringWith(m),
      () => new Error(stringWith(m)),
      () => ({ [pick(secretKeys)]: m }),
      () => ({ ['k'.repeat(257 + rnd(50))]: m }), // secret only through the long-key rule
    ])();
    return pick<() => unknown>([
      () => ({ [pick(['a', 'b', 'c'])]: nested(m, depth - 1), z: 1 }),
      () => [nested(m, depth - 1), 'x'],
      () => new Map([['k', nested(m, depth - 1)]]),
      () => new Map<unknown, unknown>([[Buffer.from(`postgres://u:${m}@h/db`), nested(m, depth - 1)]]),
      () => new Map<unknown, unknown>([[{ toString: () => m, secret: m }, nested(m, depth - 1)], [new Uint16Array([rnd(60000)]), 1]]),
      () => new Map<unknown, unknown>([[Symbol(m), m.length > 0 ? 'ok' : 'ok']]),
      () => new Set([nested(m, depth - 1)]),
    ])();
  };

  it('holds over 500 random structures', () => {
    for (let i = 0; i < 500; i++) {
      const m = marker();
      const lines = run({ root: nested(m, rnd(4)) }, () => 0, `ev ${stringWith(m)}`);
      expectSafe(lines, m);
    }
  });
});
