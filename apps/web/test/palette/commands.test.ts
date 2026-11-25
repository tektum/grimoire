import { describe, expect, it } from 'vitest';
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
});
