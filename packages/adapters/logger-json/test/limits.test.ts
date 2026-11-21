import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '../src/index.js';
import { MAX_STRING_CHARS, isSecretKey, redactString } from '../src/scrub.js';

const S = 'LEAKME';
const MB = 1_000_000;

function run(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  createJsonLogger({ level: 'debug', destination: { write: (l) => lines.push(l.trimEnd()) }, clock: { now: () => 0 } }).info('ev', fields);
  expect(lines).toHaveLength(1);
  JSON.parse(lines[0] ?? '');
  return lines[0] ?? '';
}

const shapes: readonly (readonly [string, string])[] = [
  ['all x', 'x'.repeat(MB)],
  ['all ?', '?'.repeat(MB)],
  ['all #', '#'.repeat(MB)],
  ['all @', '@'.repeat(MB)],
  ['a= repeated', 'a='.repeat(MB / 2)],
  [':// repeated', '://'.repeat(MB / 3)],
  ['alternating ?#', '?#'.repeat(MB / 2)],
  ['run of %', '%'.repeat(MB)],
  ['base64-like run', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/'.repeat(MB / 48)],
  ['run of spaces', ' '.repeat(MB)],
  ['token= repeated', 'token='.repeat(MB / 6)],
  ['eyJ repeated', 'eyJ'.repeat(MB / 3)],
  ['bearer repeated', 'bearer '.repeat(MB / 7)],
];

describe('scrubbing is linear and bounded (1 MB inputs)', () => {
  // A pattern that backtracks takes seconds on 1 MB, every time. A busy machine only slows some attempts, so the fastest of
  // five is compared with the limit: the test cannot be failed by load alone, and cannot be passed by a slow scrubber.
  it.each(shapes)('%s finishes in under 50 ms (fastest of five attempts)', (_n, value) => {
    const took: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = performance.now();
      redactString(value);
      run({ v: value, nested: { v: [value] } });
      took.push(performance.now() - t0);
    }
    expect(Math.min(...took)).toBeLessThan(50);
  });

  it('truncates long strings with a suffix and never keeps a secret past the cap', () => {
    const out = redactString(`${'word '.repeat(MAX_STRING_CHARS)}${S}`);
    expect(out).not.toContain(S);
    expect(out).toMatch(/…\[truncated \d+ chars\]$/);
    expect(out.length).toBeLessThan(MAX_STRING_CHARS + 60);
    expect(run({ v: `${'word '.repeat(MB / 5)}postgres://u:${S}@h/db` })).not.toContain(S);
  });

  it('drops a trailing partial token cut by the cap', () => {
    const out = redactString(`${'a '.repeat(MAX_STRING_CHARS / 2 - 1)}postgres://u:${S}`);
    expect(out).not.toContain('postgres');
  });

  it('caps depth, items and nodes', () => {
    const o = JSON.parse(run({ list: Array.from({ length: 1000 }, (_, i) => i) })) as { list: unknown[] };
    expect(o.list).toHaveLength(201);
    expect(o.list[200]).toBe('[truncated]');
    const wide = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i]));
    const wideOut = (JSON.parse(run({ wide })) as { wide: Record<string, unknown> }).wide;
    expect(Object.keys(wideOut)).toHaveLength(201);
    expect(wideOut['[truncated]']).toBe('800 more');
    const bigMap = new Map(Array.from({ length: 300 }, (_, i) => [`m${i}`, i] as const));
    expect((JSON.parse(run({ bigMap })) as { bigMap: Record<string, unknown> }).bigMap['[truncated]']).toBe('100 more');
    const many = Array.from({ length: 150 }, () => Array.from({ length: 150 }, () => ({ a: 1 })));
    expect(run({ many }).length).toBeLessThan(200_000);
    let deep: unknown = S;
    for (let i = 0; i < 30; i++) deep = { n: deep };
    expect(run({ deep })).not.toContain(S);
  });
});

const secretKeys = [
  'private_key', 'privateKey', 'passphrase', 'pass-phrase', 'jwt', 'bearer', 'Bearer', 'auth', 'x-auth', 'sid',
  'signature', 'otp', 'pin', 'key', 'salt', 'ssh_key', 'signing_key', 'encryption_key', 'sort_key', 'primaryKey',
  'token', 'PASSWORD', 'pass_word', 'apiKey', 'x-api-key', 'Set-Cookie', 'clientSecret', 'refreshToken',
  'sessionId', 'authToken', 'x-auth-token', 'credentials', 'connectionString', 'database_url', 'dsn', 'query',
];
const visibleKeys = ['keyboard', 'monkey', 'passenger', 'author', 'authority', 'pinned', 'signal', 'code', 'status', 'event2', 'page', 'turkey', 'hockey', 'compass', 'bypass'];
// over-redacted on purpose: the joined key contains a strong word
const overRedacted = ['sessionless', 'tokenizer', 'secretary'];

describe('key-name rule', () => {
  it.each(secretKeys)('redacts %s', (k) => {
    expect(isSecretKey(k)).toBe(true);
    expect(run({ [k]: S })).not.toContain(S);
  });
  it.each(visibleKeys)('keeps %s visible', (k) => {
    expect(isSecretKey(k)).toBe(false);
    expect(run({ [k]: 'visible-value' })).toContain('visible-value');
  });
});

const strong = ['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'jwt', 'bearer', 'authorization', 'cookie', 'session', 'credential', 'credentials', 'signature', 'apikey', 'privatekey', 'accesskey', 'secretkey', 'signingkey', 'encryptionkey', 'sshkey', 'connectionstring', 'databaseurl', 'dsn', 'csrf', 'xsrf', 'mnemonic'];
const short = ['pass', 'auth', 'sid', 'sig', 'otp', 'pin', 'salt', 'key', 'query', 'search', 'nonce', 'hmac', 'pem', 'seed', 'cert'];
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const forms = (w: string): string[] => [`${w}2`, `2${w}`, `${w}_2`, `${w}2x`, `x${w}7`, `${w}-3`, `my_${w}9`, `my${cap(w)}9`, `${w}.4`, `${w.toUpperCase()}5`];

describe('key rule with digits (K1)', () => {
  it.each(strong)('strong word %s with digit prefixes and suffixes', (w) => {
    for (const k of forms(w)) {
      expect(isSecretKey(k), k).toBe(true);
      expect(run({ [k]: S })).not.toContain(S);
    }
  });
  it.each(short)('short word %s with digit prefixes and suffixes', (w) => {
    for (const k of [`${w}2`, `2${w}`, `${w}_2`, `x_${w}7`, `${w}-3`, `my_${w}9`, `my${cap(w)}9`, `${w}.4`, `${w.toUpperCase()}5`]) {
      expect(isSecretKey(k), k).toBe(true);
      expect(run({ [k]: S })).not.toContain(S);
    }
  });
  it.each(overRedacted)('%s is redacted by the rule', (k) => {
    expect(isSecretKey(k)).toBe(true);
  });
});

describe('long keys (K3)', () => {
  it.each([255, 256, 257, 300, 1000])('a %i-character key ending in a secret word is redacted and truncated', (n) => {
    for (const k of ['k'.repeat(n) + '_token', 'k'.repeat(n) + 'Password']) {
      const line = run({ [k]: S });
      expect(line).not.toContain(S);
      expect(isSecretKey(k)).toBe(true);
    }
    const line = run({ ['k'.repeat(1000) + '_x']: S });
    expect(line).toMatch(/…\[truncated \d+ chars\]/);
    expect(line.length).toBeLessThan(600);
  });
});

describe('Map keys (K2)', () => {
  const conn = Buffer.from(`postgres://u:${S}@h/db`);
  const kinds: readonly (readonly [string, unknown])[] = [
    ['Buffer', conn],
    ['Uint8Array', new Uint8Array(conn)],
    ['Int8Array', new Int8Array(conn)],
    ['Uint8ClampedArray', new Uint8ClampedArray(conn)],
    ['Uint16Array', new Uint16Array(4)],
    ['Int16Array', new Int16Array(4)],
    ['Uint32Array', new Uint32Array(4)],
    ['Int32Array', new Int32Array(4)],
    ['Float32Array', new Float32Array(4)],
    ['Float64Array', new Float64Array(4)],
    ['BigInt64Array', new BigInt64Array(2)],
    ['BigUint64Array', new BigUint64Array(2)],
    ['DataView', new DataView(new ArrayBuffer(24))],
    ['object', { toString: () => `postgres://u:${S}@h/db`, x: S }],
    ['symbol', Symbol(S)],
    ['function', function leakme() { return S; }],
    ['Blob', new Blob([conn])],
  ];
  it.each(kinds)('%s as a Map key never leaks', (_n, key) => {
    const line = run({ m: new Map<unknown, unknown>([['k', 1], [key, 2]]) });
    expect(line).not.toContain(S);
    expect(line).not.toMatch(/\d+,\d+,\d+/);
  });
  it('writes number and boolean keys as text and binary keys as placeholders', () => {
    const o = JSON.parse(run({ m: new Map<unknown, unknown>([[1, 'a'], [true, 'b'], [new Uint8Array(24), 'c']]) })) as { m: Record<string, string> };
    expect(o.m).toEqual({ '[number 1]': 'a', '[boolean true]': 'b', '[binary 24 bytes #1]': 'c' });
  });
});

describe('Map key scheme', () => {
  it('keeps distinct non-string keys distinct and the number 1 apart from the string 1', () => {
    const m = new Map<unknown, unknown>([[1, 'num'], ['1', 'str'], [{ a: 1 }, 'o1'], [{ b: 2 }, 'o2'], [Symbol('s'), 's'],
      [new Uint8Array(3), 'b1'], [new Uint8Array(3), 'b2'], [1n, 'big']]);
    const o = JSON.parse(run({ m })) as { m: Record<string, unknown> };
    expect(o.m).toEqual({
      '[number 1]': 'num', '1': 'str', '[non-string #1]': 'o1', '[non-string #2]': 'o2', '[non-string #3]': 's',
      '[binary 3 bytes #4]': 'b1', '[binary 3 bytes #5]': 'b2', '[bigint 1]': 'big',
    });
  });
});

describe('over-long keys without a secret word', () => {
  const key = (n: number): string => 'k'.repeat(n);
  it('257 k: value redacted, key written truncated with the suffix', () => {
    expect(isSecretKey(key(257))).toBe(true);
    const line = run({ [key(257)]: 'visible-value' });
    expect(line).not.toContain('visible-value');
    expect(line).toContain(`${key(256)}…[truncated 1 chars]`);
  });
  it.each([255, 256])('%i k: value stays visible', (n) => {
    expect(isSecretKey(key(n))).toBe(false);
    const line = run({ [key(n)]: 'visible-value' });
    expect(line).toContain('visible-value');
    expect(line).not.toContain('truncated');
  });
});

describe('truncation marker (S1) and shared references (S3)', () => {
  it('marks an object cut at 200 entries', () => {
    const o = JSON.parse(run({ w: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`k${i}`, i])) })) as { w: Record<string, unknown> };
    expect(o.w['[truncated]']).toBe('101 more');
  });
  it('logs a shared (non-circular) reference every time', () => {
    const v = { c: 1 };
    const line = run({ a: { b: [v, { c: v }] } });
    expect(line).not.toContain('truncated');
  });
});

describe('Blob and binary-like objects', () => {
  it('Blob and File are placeholders', () => {
    expect(run({ b: new Blob(['abc']) })).toContain('"b":"[binary 3 bytes]"');
    expect(run({ f: new File(['abcd'], 'x.txt') })).toContain('"f":"[binary 4 bytes]"');
  });
  it('objects exposing arrayBuffer, byteLength or buffer are placeholders', () => {
    expect(run({ o: { arrayBuffer: () => 1, size: 7 } })).toContain('[binary 7 bytes]');
    expect(run({ o: { byteLength: 9, data: S } })).not.toContain(S);
    expect(run({ o: { buffer: Buffer.from(S) } })).not.toContain(S);
  });
});

describe('clock fallback (S4)', () => {
  it.each([[() => NaN], [() => { throw new Error('c'); }]])('marks events with clockFallback', (now) => {
    const lines: string[] = [];
    createJsonLogger({ destination: { write: (l) => lines.push(l) }, clock: { now } }).info('e');
    const o = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(o['clockFallback']).toBe(true);
    expect(Number.isNaN(Date.parse(String(o['ts'])))).toBe(false);
  });
});

describe('binary values', () => {
  const conn = `postgres://u:${S}@h/db`;
  const values: readonly (readonly [string, unknown, number])[] = [
    ['Buffer', Buffer.from(conn), conn.length],
    ['Uint8Array', new Uint8Array(Buffer.from(conn)), conn.length],
    ['Float64Array', new Float64Array(3), 24],
    ['ArrayBuffer', new ArrayBuffer(24), 24],
    ['SharedArrayBuffer', new SharedArrayBuffer(24), 24],
    ['DataView', new DataView(new ArrayBuffer(24)), 24],
  ];
  it.each(values)('%s is a placeholder', (_n, v, bytes) => {
    const line = run({ b: v, nested: { x: [v] } });
    expect(line).not.toContain(S);
    expect(line).not.toMatch(/\[\d+,\d+/);
    expect(line).not.toContain('"0":');
    expect(line).toContain(`[binary ${bytes} bytes]`);
  });
});
