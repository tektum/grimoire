import { describe, expect, it, vi } from 'vitest';
import { commandsFor, filterCommands, PAGES_TYPED, PAGES_UNTYPED, type CommandWorld } from '../../src/palette/commands';

const world = (over: Partial<CommandWorld> = {}): CommandWorld => ({
  role: 'member',
  collections: [
    { id: 'c1', name: 'Dev' },
    { id: 'c2', name: 'Handbook' },
  ],
  pages: [
    { id: 'p1', urlId: 'ab12cd', title: 'Quarterly plan' },
    { id: 'p2', urlId: 'zz99', title: '' },
  ],
  canMakePage: true,
  ...over,
});
const labels = (w: CommandWorld) => commandsFor(w).map((c) => `${c.group}: ${c.label}`);
const where = (id: string, w = world()) => {
  let went = '';
  commandsFor(w)
    .find((c) => c.id === id)!
    .run(
      (path) => {
        went = path;
      },
      () => {
        went = 'new page';
      },
    );
  return went;
};

describe('the commands of the palette', () => {
  it('lists the pages of the open collection, the collections, the places and New page', () => {
    expect(labels(world())).toEqual(['Pages: Quarterly plan', 'Pages: Untitled', 'Collections: Dev', 'Collections: Handbook', 'Go to: Search', 'Go to: Trash', 'Actions: New page']);
  });
  it('offers New collection to an administrator only, and it goes to the form', () => {
    expect(labels(world({ role: 'admin' }))).toContain('Actions: New collection');
    for (const role of ['member', 'viewer', undefined] as const) expect(labels(world({ role }))).not.toContain('Actions: New collection');
    const go = vi.fn();
    commandsFor(world({ role: 'admin' })).find((c) => c.label === 'New collection')?.run(go, () => undefined);
    expect(go).toHaveBeenCalledWith('/collections/new');
  });

  it('offers Admin to an administrator only', () => {
    expect(labels(world({ role: 'admin' }))).toContain('Go to: Admin');
    for (const role of ['member', 'viewer', undefined] as const) expect(labels(world({ role }))).not.toContain('Go to: Admin');
  });
  it('offers New page only where the person may write', () => {
    expect(labels(world({ canMakePage: false }))).not.toContain('Actions: New page');
  });
  it('goes where the label says, with the tree\'s address for a page (and "page" for an untitled one)', () => {
    expect(where('page:p1')).toBe('/p/quarterly-plan-ab12cd');
    expect(where('page:p2')).toBe('/p/page-zz99');
    expect(where('collection:c2')).toBe('/c/c2');
    expect(where('go:trash')).toBe('/trash');
    expect(where('go:admin', world({ role: 'admin' }))).toBe('/admin/users');
    expect(where('action:new-page')).toBe('new page');
  });
  it('shows at most a few pages before anything is typed and a screenful while typing, whatever the size of the collection (cmdk does not virtualise)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `p${String(i)}`, urlId: `u${String(i)}`, title: `Page ${String(i)}` }));
    const all = commandsFor(world({ pages: many }));
    const pages = (q: string) => filterCommands(all, q).filter((c) => c.group === 'Pages').length;
    expect(pages('')).toBe(PAGES_UNTYPED);
    expect(pages('page')).toBe(PAGES_TYPED);
    expect(pages('page 4999')).toBe(1); // the one page that matches is found even though it is far down the list
    expect(filterCommands(all, '').filter((c) => c.group !== 'Pages').length).toBe(commandsFor(world()).filter((c) => c.group !== 'Pages').length); // the other groups are not cut
  });

  it('filters by every word of the typed text, in any case, and returns all for nothing typed', () => {
    const all = commandsFor(world());
    expect(filterCommands(all, '').length).toBe(all.length);
    expect(filterCommands(all, 'QUARTERLY').map((c) => c.label)).toEqual(['Quarterly plan']);
    expect(filterCommands(all, 'plan quar').map((c) => c.label)).toEqual(['Quarterly plan']);
    expect(filterCommands(all, 'zzz')).toEqual([]);
  });

  it('lists what was opened last as Recent, goes to those pages, and offers them for an empty query only', () => {
    const recent = [
      { id: 'p2', urlId: 'zz99', title: '', path: 'Dev' },
      { id: 'p9', urlId: 'qq11', title: 'Old page', path: 'Handbook' },
    ];
    const w = world({ recent });
    expect(labels(w).filter((l) => l.startsWith('Recent'))).toEqual(['Recent: Untitled', 'Recent: Old page']);
    expect(where('recent:p9', w)).toBe('/p/old-page-qq11');
    // A page at the top of its collection has no parent: the row says the collection, by the id it was opened in.
    const top = commandsFor(world({ recent: [{ id: 'p3', urlId: 'tt22', title: 'Top', path: '', collectionId: 'c2' }, { id: 'p4', urlId: 'tt23', title: 'Lost', path: '' }] }));
    expect(top.find((c) => c.id === 'recent:p3')!.path).toBe('Handbook');
    expect(top.find((c) => c.id === 'recent:p4')!.path).toBe('');
    expect(where('recent:p2', w)).toBe('/p/page-zz99');
    const all = commandsFor(w);
    expect(filterCommands(all, '').filter((c) => c.group === 'Recent')).toHaveLength(2);
    expect(filterCommands(all, 'old').filter((c) => c.group === 'Recent')).toHaveLength(0); // typing looks in the pages, not in what was opened
  });

  it('says under a page what it is in: its parent page, or the collection at the top', () => {
    const w = world({ collectionName: 'Dev', pages: [{ id: 'a', urlId: 'a1', title: 'Parent', parentId: null }, { id: 'b', urlId: 'b1', title: 'Child', parentId: 'a' }, { id: 'c', urlId: 'c1', title: 'Orphan', parentId: 'gone' }] });
    const path = (id: string) => commandsFor(w).find((c) => c.id === id)!.path;
    expect(path('page:a')).toBe('Dev');
    expect(path('page:b')).toBe('Parent');
    expect(path('page:c')).toBe('Dev');
    expect(commandsFor(world()).find((c) => c.id === 'page:p1')!.path).toBe(''); // no collection name known
  });
});
