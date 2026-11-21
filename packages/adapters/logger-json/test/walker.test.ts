import { describe, expect, it } from 'vitest';
import { REDACTED, UNSERIALISABLE, scrubFields } from '../src/scrub.js';

const S = 'LEAKME';
const TRUNC = '[truncated]';
const nodesIn = (v: unknown): number => (typeof v === 'object' && v !== null ? 1 + Object.values(v).reduce<number>((n, c) => n + nodesIn(c), 0) : 0);

describe('field bags', () => {
  it('the placeholder text is the documented one', () => {
    expect(REDACTED).toBe('[redacted]');
    expect(scrubFields({ password: S })).toEqual({ password: '[redacted]' });
  });
  it('the reserved output keys cannot be set by a field, and everything else is kept', () => {
    expect(scrubFields({ ts: 'x', level: 'fatal', event: 'forged', a: 1, b: 'two' })).toEqual({ a: 1, b: 'two' });
  });
  it('plain values keep their type; bigint becomes text; functions and symbols are placeholders', () => {
    expect(scrubFields({ n: 1, t: true, f: false, z: null, u: undefined, big: 10n, fn: () => S, sym: Symbol(S) }))
      .toEqual({ n: 1, t: true, f: false, z: null, u: undefined, big: '10', fn: UNSERIALISABLE, sym: UNSERIALISABLE });
  });
  it('an invalid date is a placeholder and a valid one is ISO text', () => {
    expect(scrubFields({ bad: new Date(Number.NaN), ok: new Date(0) })).toEqual({ bad: '[invalid-date]', ok: '1970-01-01T00:00:00.000Z' });
  });
});

describe('errors', () => {
  it('name, message, stack and every level of the cause chain are scrubbed', () => {
    const inner = new Error(`inner token=${S}`);
    const err = new Error(`outer password=${S}`, { cause: new Error(`middle password=${S}`, { cause: inner }) });
    err.name = `Named secret=${S}`;
    err.stack = `stack https://u:${S}@h/p`;
    const out = JSON.stringify(scrubFields({ err }));
    expect(out).not.toContain(S);
    const { err: e } = scrubFields({ err }) as { err: { name: string; message: string; stack: string; cause: { message: string; cause: { message: string; cause: undefined } } } };
    expect(e.name).toBe(`Named secret=${REDACTED}`);
    expect(e.message).toBe(`outer password=${REDACTED}`);
    expect(e.stack).toBe(`stack https://${REDACTED}@h/p`);
    expect(e.cause.message).toBe(`middle password=${REDACTED}`);
    expect(e.cause.cause.message).toBe(`inner token=${REDACTED}`);
    expect(e.cause.cause.cause).toBeUndefined();
  });
  it('an error without a cause has no cause entry value', () => {
    expect((scrubFields({ e: new Error('x') }) as { e: { cause: unknown } }).e.cause).toBeUndefined();
  });
  it('an error whose cause is falsy but defined keeps it', () => {
    expect((scrubFields({ e: new Error('x', { cause: 0 }) }) as { e: { cause: unknown } }).e.cause).toBe(0);
    expect((scrubFields({ e: new Error('x', { cause: null }) }) as { e: { cause: unknown } }).e.cause).toBeNull();
  });
});

describe('binary data is never written, only its size', () => {
  it.each<[string, () => unknown, string]>([
    ['a Buffer', () => Buffer.from(S), `[binary ${S.length} bytes]`],
    ['a Uint8Array', () => new Uint8Array(7), '[binary 7 bytes]'],
    ['a Float64Array', () => new Float64Array(2), '[binary 16 bytes]'],
    ['a DataView', () => new DataView(new ArrayBuffer(5)), '[binary 5 bytes]'],
    ['an ArrayBuffer', () => new ArrayBuffer(9), '[binary 9 bytes]'],
    ['a SharedArrayBuffer', () => new SharedArrayBuffer(11), '[binary 11 bytes]'],
    ['a Blob', () => new Blob([S]), `[binary ${S.length} bytes]`],
    ['an object with an arrayBuffer method and a size', () => ({ arrayBuffer: () => S, size: 13 }), '[binary 13 bytes]'],
    ['an object with an arrayBuffer method and no size', () => ({ arrayBuffer: () => S }), '[binary ? bytes]'],
    ['an object with a byteLength', () => ({ byteLength: 4, data: S }), '[binary 4 bytes]'],
    ['an object with a buffer member', () => ({ buffer: new ArrayBuffer(3), size: 6 }), '[binary 6 bytes]'],
    ['an object with a shared buffer member', () => ({ buffer: new SharedArrayBuffer(3) }), '[binary ? bytes]'],
    ['an object with a non-numeric byteLength and an arrayBuffer method', () => ({ byteLength: 'x', arrayBuffer: () => 1, size: 2 }), '[binary 2 bytes]'],
  ])('%s', (_n, make, expected) => {
    expect(scrubFields({ v: make() })).toEqual({ v: expected });
  });
  it('an object that merely has a string buffer or size keeps its fields', () => {
    expect(scrubFields({ v: { buffer: 'x', size: 3 } })).toEqual({ v: { buffer: 'x', size: 3 } });
  });
});

describe('Map keys', () => {
  it('keys that are not strings become typed placeholders, numbered in order, so none overwrites another', () => {
    const m = new Map<unknown, unknown>([[1, 'a'], ['1', 'b'], [true, 'c'], [5n, 'd'], [Buffer.from('xy'), 'e'], [{ k: 1 }, 'f'], [[1], 'g'], [null, 'h'], [Symbol('s'), 'i']]);
    expect(scrubFields({ m })).toEqual({ m: {
      '[number 1]': 'a', 1: 'b', '[boolean true]': 'c', '[bigint 5]': 'd',
      '[binary 2 bytes #1]': 'e', '[non-string #2]': 'f', '[non-string #3]': 'g', '[non-string #4]': 'h', '[non-string #5]': 'i',
    } });
  });
  it('a secret-named string key hides its value, and a secret in a key is scrubbed', () => {
    const out = scrubFields({ m: new Map([['password', S], [`https://u:${S}@h/`, 'v']]) }) as { m: Record<string, unknown> };
    expect(out.m['password']).toBe(REDACTED);
    expect(Object.keys(out.m)).toEqual(['password', `https://${REDACTED}@h/`]);
  });
  it('a Map key that looks like a placeholder cannot be forged by a string key of an object', () => {
    expect(scrubFields({ o: { '[non-string #1]': 'x' } })).toEqual({ o: { '[non-string #1]': 'x' } });
  });
});

describe('size and depth limits', () => {
  const nest = (levels: number): Record<string, unknown> => { let o: Record<string, unknown> = { leaf: S }; for (let i = 1; i < levels; i += 1) o = { next: o }; return o; };
  it('nesting is cut at depth 8: seven nested objects are kept, the eighth is a placeholder', () => {
    const seven = JSON.stringify(scrubFields({ x: nest(7) }));
    expect(seven).toContain(S);
    expect(seven).not.toContain(TRUNC);
    const eight = JSON.stringify(scrubFields({ x: nest(8) }));
    expect(eight).toContain(TRUNC);
    expect(eight).not.toContain(S);
  });
  it('a cycle is cut, a shared reference is written each time', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(scrubFields({ a })).toEqual({ a: { name: 'a', self: TRUNC } });
    const shared = { v: 1 };
    expect(scrubFields({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });
  it.each([
    ['an array', (n: number) => Array.from({ length: n }, (_, i) => i)],
    ['a set', (n: number) => new Set(Array.from({ length: n }, (_, i) => i))],
  ] as const)('%s keeps 200 items; the 201st becomes a placeholder and the rest is dropped', (_name, make) => {
    expect((scrubFields({ l: make(200) }) as { l: unknown[] }).l).toHaveLength(200);
    const over = (scrubFields({ l: make(500) }) as { l: unknown[] }).l;
    expect(over).toHaveLength(201);
    expect(over[200]).toBe(TRUNC);
    expect((scrubFields({ l: make(201) }) as { l: unknown[] }).l[200]).toBe(TRUNC);
  });
  it.each([
    ['an object', (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]))],
    ['a Map', (n: number) => new Map(Array.from({ length: n }, (_, i) => [`k${i}`, i] as [string, number]))],
  ] as const)('%s keeps 200 entries and counts the rest', (_name, make) => {
    const at = (scrubFields({ o: make(200) }) as { o: Record<string, unknown> }).o;
    expect(Object.keys(at)).toHaveLength(200);
    expect(at[TRUNC]).toBeUndefined();
    const over = (scrubFields({ o: make(201) }) as { o: Record<string, unknown> }).o;
    expect(Object.keys(over)).toHaveLength(201);
    expect(over[TRUNC]).toBe('1 more');
    expect((scrubFields({ o: make(500) }) as { o: Record<string, unknown> }).o[TRUNC]).toBe('300 more');
  });
  it('2000 nodes are written and the 2001st is a placeholder', () => {
    const arrays = (counts: number[]) => Object.fromEntries(counts.map((c, i) => [`a${i}`, Array.from({ length: c }, () => ({}))]));
    const exact = arrays([...Array.from({ length: 9 }, () => 200), 189]); // the bag, 10 lists and 1989 objects: 2000 nodes
    const out = scrubFields(exact);
    expect(nodesIn(out)).toBe(2000);
    expect(JSON.stringify(out)).not.toContain(TRUNC);
    const over = scrubFields(arrays([...Array.from({ length: 9 }, () => 200), 190]));
    expect(JSON.stringify(over).split(TRUNC).length - 1).toBe(1);
  });
});

describe('hostile and unusual inputs', () => {
  it('a value that throws while being read becomes a placeholder and its neighbours are kept', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error(S); } });
    expect(scrubFields({ before: 1, hostile, after: 2 })).toEqual({ before: 1, hostile: UNSERIALISABLE, after: 2 });
  });
  it('a getter that throws gives a placeholder for that field only', () => {
    const o = { ok: 1, get bad(): string { throw new Error(S); } };
    expect(scrubFields({ o })).toEqual({ o: { ok: 1, bad: UNSERIALISABLE } });
  });
  it('a field bag that is not a plain object gives one placeholder field; none, null or undefined gives an empty bag', () => {
    expect(scrubFields([1, 2] as unknown as Record<string, unknown>)).toEqual({ fields: UNSERIALISABLE });
    expect(scrubFields('text' as unknown as Record<string, unknown>)).toEqual({ fields: UNSERIALISABLE });
    expect(scrubFields(Buffer.from(S) as unknown as Record<string, unknown>)).toEqual({ fields: UNSERIALISABLE });
    expect(scrubFields(undefined)).toEqual({});
    expect(scrubFields(null as unknown as Record<string, unknown>)).toEqual({});
  });
  it('a long cause chain is cut at the depth limit and a secret past it is not written', () => {
    let err = new Error(`deepest password=${S}`);
    for (let i = 0; i < 12; i += 1) err = new Error(`level ${i}`, { cause: err });
    const out = JSON.stringify(scrubFields({ err }));
    expect(out).toContain(TRUNC);
    expect(out).not.toContain('deepest');
  });
  it('lists nested deeper than the limit are cut, and a secret past it is not written', () => {
    let list: unknown = [`deepest password=${S}`];
    for (let i = 0; i < 12; i += 1) list = [list];
    const out = JSON.stringify(scrubFields({ list }));
    expect(out).toContain(TRUNC);
    expect(out).not.toContain('deepest');
  });
});
