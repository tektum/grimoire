import { describe, expect, it } from 'vitest';
import { FakeOrdering } from '../../src/testing/fake-position.js';
import { OrderingNotAvailable, unavailableOrdering } from '../../src/tree/position.js';

describe('the ordering that is not available yet', () => {
  it('throws OrderingNotAvailable from both functions', () => {
    expect(() => unavailableOrdering.between(null, null)).toThrow(OrderingNotAvailable);
    expect(() => unavailableOrdering.isValidPosition('a0')).toThrow(OrderingNotAvailable);
  });
  it('names the error so a route can map it to 503 without reading its message', () => {
    expect(new OrderingNotAvailable().name).toBe('OrderingNotAvailable');
  });
});

describe('FakeOrdering', () => {
  const order = new FakeOrdering();

  it('gives a key for an empty list and keeps appends and prepends in order', () => {
    const first = order.between(null, null);
    const after = order.between(first, null);
    const before = order.between(null, first);
    expect([before, first, after].sort()).toEqual([before, first, after]);
    expect(new Set([before, first, after]).size).toBe(3);
  });

  it('returns a key strictly between two neighbours, also when they are adjacent characters', () => {
    expect(order.between('a', 'b')).toSatisfy((k: string) => k > 'a' && k < 'b');
    expect(order.between('a0', 'a1')).toSatisfy((k: string) => k > 'a0' && k < 'a1');
    expect(order.between('a', 'a1')).toSatisfy((k: string) => k > 'a' && k < 'a1');
  });

  it('keeps a list strictly sorted through many inserts at a fixed place and at random places', () => {
    let seed = 7;
    const random = (n: number): number => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const keys: string[] = [order.between(null, null)];
    for (let i = 0; i < 300; i += 1) {
      const at = random(keys.length + 1); // position in the list; 0 = front, length = end
      keys.splice(at, 0, order.between(keys[at - 1] ?? null, keys[at] ?? null));
    }
    for (let i = 1; i < keys.length; i += 1) expect((keys[i - 1] as string) < (keys[i] as string), `${String(i)}`).toBe(true);
    let low = order.between('a', 'b');
    for (let i = 0; i < 100; i += 1) low = order.between('a', low);
    expect(low > 'a' && low < 'b').toBe(true);
  });

  it('refuses neighbours that are not in order', () => {
    expect(() => order.between('b', 'a')).toThrow(RangeError);
    expect(() => order.between('a', 'a')).toThrow(RangeError);
  });

  it('says so when no key fits between two neighbours', () => {
    expect(() => order.between('a', 'a0')).toThrow(RangeError);
  });

  it('accepts only non-empty keys of ASCII letters and digits', () => {
    for (const good of [order.between(null, null), 'a0', 'Zz9']) expect(order.isValidPosition(good), good).toBe(true);
    for (const bad of ['', 'a ', 'a-1', 'é']) expect(order.isValidPosition(bad), bad).toBe(false);
  });
});
