import { describe, expect, it } from 'vitest';
import { buildLinkIndex } from '../../../src/import/link-index.js';
import { resolveNotionLink } from '../../../src/import/notion/links.js';
import { idOf as idOfName } from '../../../src/import/notion/names.js';
import type { IndexedItem } from '../../../src/import/profile.js';

const buildIndex = (items: readonly IndexedItem[]) => buildLinkIndex(items, idOfName);
import { notionExportFiles } from '../fixtures/notion-synthetic/build.js';

// M7-T06: the link forms of the synthetic export (constructed, not observed) resolve to the page items by normalised path and by id, and to attachments; what is not in the export stays.
const files = notionExportFiles();
const index = buildIndex([...files.keys()].map((path, i) => ({ itemId: `item-${String(i)}`, path, kind: path.endsWith('.md') ? 'page' : 'attachment' })));
const idOf = (path: string): string | undefined => index.byPath.get(path)?.itemId;
const home = [...files.keys()].find((p) => p.startsWith('Home ') && p.endsWith('.md') && !p.includes('/')) as string;
const child = [...files.keys()].find((p) => p.startsWith('Home ') && p.includes('/Child page') && p.endsWith('.md') && p.split('/').length === 2) as string;
const grand = [...files.keys()].find((p) => p.includes('Grandchild')) as string;

describe('links between pages', () => {
  it('resolves a percent-encoded relative link, and the same link written with spaces', () => {
    expect(resolveNotionLink(`${encodeURI(home.replace('.md', ''))}/${encodeURIComponent(child.split('/')[1] as string)}`, home, index)).toMatchObject({ kind: 'page', itemId: idOf(child) });
    expect(resolveNotionLink(`${home.replace('.md', '')}/${child.split('/')[1] as string}`, home, index)).toMatchObject({ kind: 'page', itemId: idOf(child) });
  });

  it('resolves ../ and the encoded slash form', () => {
    expect(resolveNotionLink(`../${encodeURIComponent(home)}`, child, index)).toMatchObject({ kind: 'page', itemId: idOf(home) });
    expect(resolveNotionLink(`../../${home}`, grand, index)).toMatchObject({ kind: 'page', itemId: idOf(home) });
  });

  it('keeps the fragment, apart from the target', () => {
    const r = resolveNotionLink(`../${encodeURIComponent(home)}#section-two`, child, index);
    expect(r).toMatchObject({ kind: 'page', itemId: idOf(home), fragment: 'section-two' });
  });

  it('falls back to the id when the path does not match (a page that moved, or a renamed folder)', () => {
    const id = /([a-f0-9]{32})\.md$/.exec(child)?.[1] as string;
    expect(resolveNotionLink(`Renamed%20folder/Whatever%20name%20${id}.md`, 'x.md', index)).toMatchObject({ kind: 'page', itemId: idOf(child) });
  });
});

describe('images and files', () => {
  it('an image in a sibling folder is an attachment', () => {
    const media = [...files.keys()].find((p) => p.endsWith('/picture.png')) as string;
    const from = [...files.keys()].find((p) => p.includes('/Media ') && p.endsWith('.md')) as string;
    expect(resolveNotionLink(encodeURI(media.slice(from.lastIndexOf('/') + 1)), from, index)).toMatchObject({ kind: 'attachment', itemId: idOf(media) });
    expect(resolveNotionLink('../Assets/other.png', from, index)).toMatchObject({ kind: 'attachment', itemId: idOf('Assets/other.png') });
  });
});

describe('the index keys are canonical like the targets a link resolves to', () => {
  it('finds an entry whose archive path has . and empty segments, by the path without them', () => {
    const odd = buildIndex([{ itemId: 'p', path: 'dir/./Sub  Page.md'.replace('  ', ' '), kind: 'page' }, { itemId: 'q', path: './dir//other.md', kind: 'page' }, { itemId: 'r', path: 'caf\u00e9/x.md', kind: 'page' }]);
    expect(resolveNotionLink('Sub%20Page.md', 'dir/a.md', odd)).toMatchObject({ itemId: 'p' });
    expect(resolveNotionLink('other.md', 'dir/a.md', odd)).toMatchObject({ itemId: 'q' });
    expect(resolveNotionLink('cafe\u0301/x.md', 'a.md', odd)).toMatchObject({ itemId: 'r' }); // NFC
  });
});

describe('what a resolved link is', () => {
  it('is the id of an item of the export (and a fragment), never a path: nothing here can be written into a page as an href', () => {
    const r = resolveNotionLink(`../${encodeURIComponent(home)}#top`, child, index);
    expect(Object.keys(r ?? {}).sort()).toEqual(['fragment', 'itemId', 'kind']);
    // even a path that holds a colon is only looked up: it comes back as an item, not as text
    const withColon = buildIndex([{ itemId: 'x', path: 'dir/a:b.md', kind: 'page' }]);
    expect(resolveNotionLink('./a:b.md', 'dir/index.md', withColon)).toEqual({ kind: 'page', itemId: 'x' });
  });
});

describe('databases', () => {
  const DB = '0123456789abcdef0123456789abcdef';
  it('a link to `X <id>.csv` finds `X <id>_all.csv` when the export holds only that one (as a real export does), and the plain one when it is there', () => {
    const onlyAll = buildIndex([{ itemId: 'all', path: `Work/Tasks ${DB}_all.csv`, kind: 'attachment' }]);
    expect(resolveNotionLink(`Tasks%20${DB}.csv`, 'Work/Home.md', onlyAll)).toMatchObject({ itemId: 'all' });
    const both = buildIndex([{ itemId: 'all', path: `Work/Tasks ${DB}_all.csv`, kind: 'attachment' }, { itemId: 'plain', path: `Work/Tasks ${DB}.csv`, kind: 'attachment' }]);
    expect(resolveNotionLink(`Tasks%20${DB}.csv`, 'Work/Home.md', both)).toMatchObject({ itemId: 'plain' });
  });

  it('the id of `X <id>_all.csv` is its id, so a link elsewhere finds it by the id', () => {
    expect(idOfName(`Work/Tasks ${DB}_all.csv`)).toBe(DB);
    const index = buildIndex([{ itemId: 'all', path: `Work/Tasks ${DB}_all.csv`, kind: 'attachment' }]);
    expect(resolveNotionLink(`../Archive/Old%20Tasks%20${DB}.csv`, 'Elsewhere/Home.md', index)).toMatchObject({ itemId: 'all' });
  });

  it('by the id too, the plain one when it is there, whatever the order of the items: the id falls back as the path does', () => {
    const items = [{ itemId: 'all', path: `Work/Tasks ${DB}_all.csv`, kind: 'attachment' }, { itemId: 'plain', path: `Work/Tasks ${DB}.csv`, kind: 'attachment' }] as const;
    for (const order of [items, [...items].reverse()]) {
      expect(resolveNotionLink(`../Archive/Old%20Tasks%20${DB}.csv`, 'Elsewhere/Home.md', buildIndex(order))).toMatchObject({ itemId: 'plain' });
    }
  });
});

describe('what does not resolve', () => {
  it.each(['https://example.com/x', 'mailto:a@b.c', '#top', '../../../../escape.md', 'Missing%20page%2088ac0cea4cb245efb44d63ace0a37d1e.md', 'nowhere.md'])('%s is left as it is', (url) => {
    expect(resolveNotionLink(url, home, index)).toBeUndefined();
  });
});
