import { describe, expect, it } from 'vitest';
import { InvalidSearchCursor, decodeSearchCursor, encodeSearchCursor } from '../../src/search/cursor.js';

const key = { rank: 0.0607927, editedAt: 1_700_000_000_123, id: '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999' } as const;

describe('the search cursor', () => {
  it('round-trips', () => {
    expect(decodeSearchCursor(encodeSearchCursor(key))).toEqual(key);
    expect(encodeSearchCursor(key)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts every rank a float4 can hold, down to the largest, and zero', () => {
    for (const rank of [0, 1e-30, 3.4028234663852886e38, -3.4028234663852886e38]) expect(decodeSearchCursor(encodeSearchCursor({ ...key, rank })).rank).toBe(rank);
  });

  it('rejects anything that is not a cursor this module made', () => {
    const good = encodeSearchCursor(key);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      '', 'not base64url!', good.slice(0, -4), `${good}x`, `${good}=`, Buffer.from('{}').toString('base64url'), b64({ k: [1, 2] }), b64({ k: [1, 'x', 'id'] }), b64({ k: ['a', 1, 'id'] }),
      b64({ k: [1, 2, 'not-a-uuid'] }), b64({ k: [Number.NaN, 2, key.id] }), b64({ k: [1, 2, key.id], extra: 1 }), b64([1, 2, key.id]), Buffer.from('{"k":[1,2,"').toString('base64url'),
      b64({ k: [1, 1.5, key.id] }), b64({ k: [1e100, 1, key.id] }), b64({ k: [-1e39, 1, key.id] }), // a rank PostgreSQL's float4 refuses (22003): never reach the query
    ]) {
      expect(() => decodeSearchCursor(bad), bad).toThrow(InvalidSearchCursor);
    }
  });
});
