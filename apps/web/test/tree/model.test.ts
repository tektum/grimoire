import { describe, expect, it } from 'vitest';
import { buildTree, pagePath, slugOf, type FlatPage } from '../../src/tree/model';
import { urlIdOf } from '../../src/app/routes';

const page = (id: string, parentId: string | null, position: string, title = id): FlatPage => ({ id, urlId: id.slice(0, 8), parentId, position, title, icon: null });

describe('buildTree', () => {
  it('nests a flat list under its parents and orders siblings by position, as bytes', () => {
    const tree = buildTree([
      page('c0000000-0', 'a0000000-0', 'p2'),
      page('a0000000-0', null, 'p1'),
      page('b0000000-0', null, 'B'), // upper case sorts before lower case: bytes, not locale
      page('d0000000-0', 'a0000000-0', 'p1'),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['b0000000-0', 'a0000000-0']);
    expect(tree[1]?.children?.map((n) => n.id)).toEqual(['d0000000-0', 'c0000000-0']);
  });

  it('orders pages with the same position by id, so the order never changes between two reads', () => {
    const tree = buildTree([page('b0000000-0', null, 'p1'), page('a0000000-0', null, 'p1')]);
    expect(tree.map((n) => n.id)).toEqual(['a0000000-0', 'b0000000-0']);
  });

  it('is an empty list for no pages', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('gives a leaf no children list, so the tree shows it without a toggle', () => {
    const [only] = buildTree([page('a0000000-0', null, 'p1')]);
    expect(only?.children).toBeUndefined();
  });

  it('puts a page whose parent is missing at the top level instead of losing it', () => {
    const tree = buildTree([page('a0000000-0', 'ffffffff-0', 'p1')]);
    expect(tree.map((n) => n.id)).toEqual(['a0000000-0']);
  });

  it('does not loop on a cycle: the pages of a cycle are left out and the rest is kept', () => {
    const tree = buildTree([page('a0000000-0', 'b0000000-0', 'p1'), page('b0000000-0', 'a0000000-0', 'p1'), page('c0000000-0', null, 'p1')]);
    expect(tree.map((n) => n.id)).toEqual(['c0000000-0']);
  });

  it('keeps the title and icon as given, and shows Untitled for an empty title', () => {
    const [a, b] = buildTree([{ ...page('a0000000-0', null, 'p1'), title: 'Plan', icon: '📘' }, { ...page('b0000000-0', null, 'p2'), title: '' }]);
    expect([a?.name, a?.icon, b?.name]).toEqual(['Plan', '📘', 'Untitled']);
  });
});

describe('slugOf and pagePath', () => {
  it.each([
    ['Plan for May', 'plan-for-may'],
    ['  Ünïcode — tïtle!  ', 'n-code-t-tle'],
    ['', 'page'],
    ['日本語', 'page'],
    ['a'.repeat(100), 'a'.repeat(60)],
  ])('turns %j into the slug %j', (title, slug) => {
    expect(slugOf(title)).toBe(slug);
  });

  it('builds /p/<slug>-<urlId> and the route reads the urlId back', () => {
    const path = pagePath('Plan for May', 'a1b2c3d4');
    expect(path).toBe('/p/plan-for-may-a1b2c3d4');
    expect(urlIdOf(path.slice(3))).toBe('a1b2c3d4');
  });
});
