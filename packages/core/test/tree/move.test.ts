import { describe, expect, it } from 'vitest';
import { FakeOrdering } from '../../src/testing/fake-position.js';
import { checkMove, depthOf, forestOf, heightOf, isSelfOrDescendant } from '../../src/tree/move.js';

// a (b (d, e (f)), c)
const forest = forestOf([
  { id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'a' },
  { id: 'd', parentId: 'b' }, { id: 'e', parentId: 'b' }, { id: 'f', parentId: 'e' }, { id: 'z', parentId: null },
]);

describe('depthOf and heightOf', () => {
  it('count levels from the top and from the page down', () => {
    expect(['a', 'b', 'f', 'z'].map((id) => depthOf(forest, id))).toEqual([1, 2, 4, 1]);
    expect(['a', 'b', 'f', 'z', 'c'].map((id) => heightOf(forest, id))).toEqual([4, 3, 1, 1, 1]);
  });

  it('stop on a loop in the data instead of looping', () => {
    const loop = forestOf([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }]);
    expect(depthOf(loop, 'x')).toBe(2);
    expect(heightOf(loop, 'x')).toBeLessThanOrEqual(3);
    expect(isSelfOrDescendant(loop, 'q', 'x')).toBe(false);
  });
});

describe('isSelfOrDescendant', () => {
  it('is true for the page itself and anything below it, false for the rest', () => {
    expect(isSelfOrDescendant(forest, 'b', 'b')).toBe(true);
    expect(isSelfOrDescendant(forest, 'b', 'f')).toBe(true);
    expect(isSelfOrDescendant(forest, 'b', 'a')).toBe(false);
    expect(isSelfOrDescendant(forest, 'b', 'c')).toBe(false);
    expect(isSelfOrDescendant(forest, 'b', 'nowhere')).toBe(false);
  });
});

describe('checkMove', () => {
  it('refuses a move under itself or a descendant', () => {
    expect(checkMove(forest, { id: 'b', newParent: 'b', maxDepth: 32 })).toBe('would-create-cycle');
    expect(checkMove(forest, { id: 'b', newParent: 'f', maxDepth: 32 })).toBe('would-create-cycle');
  });

  it('allows a move to the top level, to a sibling branch and to another tree', () => {
    expect(checkMove(forest, { id: 'b', newParent: null, maxDepth: 32 })).toBe('ok');
    expect(checkMove(forest, { id: 'd', newParent: 'c', maxDepth: 32 })).toBe('ok');
    expect(checkMove(forest, { id: 'b', newParent: 'z', maxDepth: 32 })).toBe('ok');
  });

  it('counts the whole moved subtree against the depth limit', () => {
    // b has height 3; under z (depth 1) it would reach level 4.
    expect(checkMove(forest, { id: 'b', newParent: 'z', maxDepth: 4 })).toBe('ok');
    expect(checkMove(forest, { id: 'b', newParent: 'z', maxDepth: 3 })).toBe('too-deep');
    expect(checkMove(forest, { id: 'b', newParent: null, maxDepth: 3 })).toBe('ok');
    expect(checkMove(forest, { id: 'b', newParent: null, maxDepth: 2 })).toBe('too-deep');
  });
});

describe('sibling order with the test ordering', () => {
  it('stays strictly ascending after 1,000 inserts at random places', () => {
    const ordering = new FakeOrdering();
    const keys: string[] = [];
    let seed = 12345;
    const random = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 1000; i += 1) {
      const at = random(keys.length + 1);
      keys.splice(at, 0, ordering.between(keys[at - 1] ?? null, keys[at] ?? null));
    }
    expect(keys).toHaveLength(1000);
    expect(keys.every((key, i) => i === 0 || (keys[i - 1] as string) < key)).toBe(true);
  });
});
