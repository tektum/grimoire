import { describe, expect, it } from 'vitest';
import { decodeHybridCursor, decodeSearchCursor, encodeHybridCursor, encodeSearchCursor, InvalidSearchCursor } from '../../../src/search/cursor.js';

const ID = '00000000-0000-4000-8000-000000000001';
const raw = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');

describe('the cursor of a hybrid answer', () => {
  it('is read back as it was made, keeps the whole precision of a score, and is not a cursor of the full-text search', () => {
    const key = { rank: 1 / 61 + 1 / 63, editedAt: 1_700_000_000_123_456, id: ID };
    const cursor = encodeHybridCursor(key);
    expect(decodeHybridCursor(cursor)).toEqual(key);
    expect(() => decodeSearchCursor(cursor)).toThrow(InvalidSearchCursor);
  });

  it('is undefined for a cursor of the full-text search (that search continues it), and the full-text decoder still reads that one', () => {
    const cursor = encodeSearchCursor({ rank: 0.5, editedAt: 1000, id: ID });
    expect(decodeHybridCursor(cursor)).toBeUndefined();
    expect(decodeSearchCursor(cursor).id).toBe(ID);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not a cursor!'],
    ['not JSON', raw('{nope')],
    ['not an object', raw([1, 2, 3])],
    ['a number', raw(7)],
    ['null', raw('null')],
    ['an empty object', raw({})],
    ['two keys', raw({ h: [0.1, 1, ID], k: 1 })],
    ['no list', raw({ h: 'x' })],
    ['a list of two', raw({ h: [0.1, 1] })],
    ['a score of zero', raw({ h: [0, 1, ID] })],
    ['a negative score', raw({ h: [-0.1, 1, ID] })],
    ['a score that is not finite', raw('{"h":[1e999,1,"' + ID + '"]}')],
    ['a score that is text', raw({ h: ['0.1', 1, ID] })],
    ['a time that is not an integer', raw({ h: [0.1, 1.5, ID] })],
    ['a time that is text', raw({ h: [0.1, '1', ID] })],
    ['an id that is not a UUID', raw({ h: [0.1, 1, 'page-1'] })],
    ['an id that is a number', raw({ h: [0.1, 1, 7] })],
    ['a full-text cursor with a wrong key', raw({ k: [0.5, 1, 'not-a-uuid'] })],
    ['too long', 'A'.repeat(1025)],
  ])('refuses %s as invalid', (_name, cursor) => {
    expect(() => decodeHybridCursor(cursor)).toThrow(InvalidSearchCursor);
  });

  it('refuses a cursor that holds the right numbers in a form this module did not make (extra white space), as every part becomes a comparison', () => {
    const spaced = raw(`{ "h": [0.1, 1, "${ID}"] }`);
    expect(() => decodeHybridCursor(spaced)).toThrow(InvalidSearchCursor);
  });
});
