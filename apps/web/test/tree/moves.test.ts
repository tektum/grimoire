import { describe, expect, it } from 'vitest';
import { buildTree } from '../../src/tree/model';
import { applyCreate, applyDelete, applyMove, applyRename, descendantsOf, moveTargets, planDrop } from '../../src/tree/moves';
import type { FlatPage } from '../../src/tree/model';

const p = (id: string, parentId: string | null, position: string, title = id): FlatPage => ({ id, urlId: id, parentId, position, title, icon: null });
// Top level: a, b, c. a holds a1 and a2; a1 holds a1x.
const PAGES = [p('a', null, 'p1'), p('b', null, 'p2'), p('c', null, 'p3'), p('a1', 'a', 'p1'), p('a2', 'a', 'p2'), p('a1x', 'a1', 'p1')];

describe('descendantsOf', () => {
  it('lists every page below a page, at any depth, and not the page itself', () => {
    expect([...descendantsOf(PAGES, 'a')].sort()).toEqual(['a1', 'a1x', 'a2']);
    expect([...descendantsOf(PAGES, 'c')]).toEqual([]);
  });
});

describe('planDrop (where a dragged page goes, as the API asks for it)', () => {
  it('drops after the sibling just above the drop place', () => {
    expect(planDrop(PAGES, 'a', null, 2)).toEqual({ parentId: null, afterId: 'b', beforeId: null }); // between b and c
  });
  it('counts the dragged page out of its own list when it moves down within the same parent', () => {
    expect(planDrop(PAGES, 'a', null, 3)).toEqual({ parentId: null, afterId: null, beforeId: null }); // below c: the end of the list, a no longer counts
    expect(planDrop(PAGES, 'a', null, 2)).toEqual({ parentId: null, afterId: 'b', beforeId: null });
  });
  it('drops at the end of a parent, also into a parent with no child yet', () => {
    expect(planDrop(PAGES, 'c', 'a', 2)).toEqual({ parentId: 'a', afterId: null, beforeId: null });
    expect(planDrop(PAGES, 'a1x', 'b', 0)).toEqual({ parentId: 'b', afterId: null, beforeId: null });
  });
  it('drops before the first sibling when the drop place is above it', () => {
    expect(planDrop(PAGES, 'c', null, 0)).toEqual({ parentId: null, afterId: null, beforeId: 'a' });
    expect(planDrop(PAGES, 'c', 'a', 0)).toEqual({ parentId: 'a', afterId: null, beforeId: 'a1' });
  });
  it('refuses to drop a page into itself or below itself', () => {
    expect(planDrop(PAGES, 'a', 'a', 0)).toBe('cycle');
    expect(planDrop(PAGES, 'a', 'a1x', 0)).toBe('cycle');
  });
});

describe('moveTargets (the "Move to…" list)', () => {
  it('lists the top level and every page except the page and what is below it, in tree order with its depth', () => {
    expect(moveTargets(PAGES, 'a1')).toEqual([
      { parentId: null, label: 'Top level', depth: 0 },
      { parentId: 'a', label: 'a', depth: 0 },
      { parentId: 'a2', label: 'a2', depth: 1 },
      { parentId: 'b', label: 'b', depth: 0 },
      { parentId: 'c', label: 'c', depth: 0 },
    ]);
  });
  it('leaves out the page itself and the whole branch, so a page cannot be offered itself', () => {
    expect(moveTargets(PAGES, 'a').map((t) => t.parentId)).toEqual([null, 'b', 'c']);
  });
});

describe('local changes (shown at once, replaced by the next read of the tree)', () => {
  it('creates, renames and deletes a page, and a delete takes its sub-pages with it', () => {
    expect(applyCreate(PAGES, p('n', 'b', 'p9', ''))).toHaveLength(7);
    expect(applyRename(PAGES, 'b', 'Plan').find((x) => x.id === 'b')?.title).toBe('Plan');
    expect(applyDelete(PAGES, 'a').map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('moves a page under a parent, after or before a sibling, or last, by giving it a sort key that fits the place', () => {
    const under = { parentId: 'b', afterId: null, beforeId: null };
    expect(applyMove(PAGES, 'c', under).find((x) => x.id === 'c')?.parentId).toBe('b');
    const order = (pages: readonly FlatPage[], parent: string | null) => pages.filter((x) => x.parentId === parent).sort((x, y) => (x.position < y.position ? -1 : 1)).map((x) => x.id);
    expect(order(applyMove(PAGES, 'c', { parentId: null, afterId: 'a', beforeId: null }), null)).toEqual(['a', 'c', 'b']);
    expect(order(applyMove(PAGES, 'a1', { parentId: 'a', afterId: null, beforeId: null }), 'a')).toEqual(['a2', 'a1']);
    expect(order(applyMove(PAGES, 'c', { parentId: null, afterId: null, beforeId: 'a' }), null)).toEqual(['c', 'a', 'b']); // first
    expect(order(applyMove(PAGES, 'c', { parentId: null, afterId: null, beforeId: 'b' }), null)).toEqual(['a', 'c', 'b']); // between
    expect(order(applyMove(PAGES, 'a1', under), 'b')).toEqual(['a1']);
  });

  it('gives the moved page a key that sorts between the neighbours when the server keys are fractional (a0, then a0V, then a1)', () => {
    const keyed = [p('x', null, 'a0'), p('y', null, 'a0V'), p('z', null, 'a1'), p('m', null, 'b')];
    const order = (pages: readonly FlatPage[]) => buildTree(pages).map((i) => i.id);
    expect(order(applyMove(keyed, 'm', { parentId: null, afterId: 'x', beforeId: null }))).toEqual(['x', 'm', 'y', 'z']); // after x, before y
    expect(order(applyMove(keyed, 'm', { parentId: null, afterId: null, beforeId: 'y' }))).toEqual(['x', 'm', 'y', 'z']);
    expect(order(applyMove(keyed, 'm', { parentId: null, afterId: null, beforeId: 'x' }))).toEqual(['m', 'x', 'y', 'z']);
    expect(order(applyMove(keyed, 'm', { parentId: null, afterId: 'y', beforeId: null }))).toEqual(['x', 'y', 'm', 'z']);
  });
});
