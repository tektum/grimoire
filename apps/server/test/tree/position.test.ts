import { describe, expect, it } from 'vitest';
import { createOrdering, InvalidNeighbours } from '../../src/tree/position.js';

const ordering = createOrdering();

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ascending = (keys: string[]) => keys.every((k, i) => i === 0 || keys[i - 1]! < k);

describe('ordering.between', () => {
  it('gives a valid key for two open ends', () => {
    expect(ordering.isValidPosition(ordering.between(null, null))).toBe(true);
  });

  it('keeps 1,000 seeded random inserts strictly ascending with no duplicate', () => {
    const rnd = seeded(42);
    const list: string[] = [ordering.between(null, null)];
    for (let n = 0; n < 1000; n++) {
      const i = Math.floor(rnd() * (list.length + 1));
      list.splice(i, 0, ordering.between(list[i - 1] ?? null, list[i] ?? null));
    }
    expect(ascending(list)).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it('survives 10,000 inserts at the front', { timeout: 30_000 }, () => {
    let first = ordering.between(null, null);
    for (let n = 0; n < 10_000; n++) {
      const k = ordering.between(null, first);
      expect(k < first).toBe(true);
      expect(ordering.isValidPosition(k)).toBe(true);
      first = k;
    }
  });

  it('survives 10,000 inserts at the end', { timeout: 30_000 }, () => {
    let last = ordering.between(null, null);
    for (let n = 0; n < 10_000; n++) {
      const k = ordering.between(last, null);
      expect(k > last).toBe(true);
      expect(ordering.isValidPosition(k)).toBe(true);
      last = k;
    }
  });

  it('throws a typed error for equal, reversed and invalid neighbours', () => {
    const a = ordering.between(null, null);
    const b = ordering.between(a, null);
    expect(() => ordering.between(a, a)).toThrow(InvalidNeighbours);
    expect(() => ordering.between(b, a)).toThrow(InvalidNeighbours);
    expect(() => ordering.between('!', null)).toThrow(InvalidNeighbours);
    expect(() => ordering.between(null, 5 as unknown as string)).toThrow(InvalidNeighbours);
    expect(() => ordering.between('a0', 'a1')).not.toThrow();
  });

});

describe('ordering.isValidPosition', () => {
  const backfilled = ['a0000001' + '1', 'a0000002' + '1', 'a0000010' + '1'];
  const sequence = ['a0', 'a1', 'a2', 'a9'];

  it('accepts backfilled and sequence keys, rejects junk', () => {
    for (const k of [...backfilled, ...sequence]) expect(ordering.isValidPosition(k)).toBe(true);
    for (const k of ['', '!', 'a0 ', 'a0-', 'b']) expect(ordering.isValidPosition(k)).toBe(false);
  });

  it('orders new keys correctly against existing ones', () => {
    const all = [...backfilled, ...sequence].sort();
    for (let i = 0; i < all.length - 1; i++) {
      const k = ordering.between(all[i]!, all[i + 1]!);
      expect(all[i]! < k && k < all[i + 1]!).toBe(true);
    }
    expect(ordering.between(all.at(-1)!, null) > all.at(-1)!).toBe(true);
  });
});
