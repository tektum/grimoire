import { describe, expect, it } from 'vitest';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { passOne } from '../../../src/import/engine.js';
import type { PassOneEntry } from '../../../src/import/engine.js';
import { markdownProfile } from '../../../src/import/markdown-profile.js';

// Stage 3 (M7 contracts section 4): every entry once, classified, with the folders that have no page of their own as empty container pages.
const entry = (path: string, over: Partial<PassOneEntry> = {}): PassOneEntry => ({ index: 0, path, nameValid: true, isDirectory: path.endsWith('/'), ...over });
const entries = (...paths: string[]): PassOneEntry[] => paths.map((p, index) => entry(p, { index }));
const OPTIONS = { profile: markdownProfile, allowNestedZips: false, maxPages: 10_000 };

async function run(list: readonly PassOneEntry[], over: Partial<typeof OPTIONS> = {}) {
  const repo = new FakeImportRepo();
  const made = repo.seed({ id: 'imp', tenantId: 't', status: 'running' });
  const result = await passOne(repo, 't', made.id, list, { ...OPTIONS, ...over });
  const items = await repo.scanItems('t', made.id, { limit: 1000 });
  return { repo, result, items, byPath: (p: string) => items.find((i) => i.path === p) };
}

describe('classification', () => {
  it('pages and attachments are pending items, in the order of the archive, and the counts say how many', async () => {
    const { result, items } = await run(entries('a.md', 'img/cat.png', 'dir/b.md'));
    expect(items.filter((i) => i.path !== 'dir/').map((i) => [i.path, i.kind, i.status])).toEqual([['a.md', 'page', 'pending'], ['img/cat.png', 'attachment', 'pending'], ['dir/b.md', 'page', 'pending']]);
    expect(result).toEqual({ ok: true, pagesTotal: 3, attachments: 1, skipped: 0, failed: 0 }); // a.md, dir/b.md and the container page of dir
  });

  it.each([['__MACOSX/._a.md'], ['dir/.DS_Store'], ['Thumbs.db'], ['somedir/']])('%s is skipped as ignored, never read', async (path) => {
    const { items, result } = await run(entries('a.md', path));
    const item = items.find((i) => i.path === path);
    expect(item).toMatchObject({ kind: 'other', status: 'skipped', message: 'ignored' });
    expect(result).toMatchObject({ ok: true, skipped: 1 });
  });

  it('a name that is not valid UTF-8, or has a control character, is one failed item bad_name under a cleaned, indexed name; the rest is imported', async () => {
    const list = [entry('a.md', { index: 0 }), entry('bad\uFFFD.md', { index: 1, nameValid: false }), entry('line\nbreak.md', { index: 2 }), entry('line\rbreak.md', { index: 3 })];
    const { items, result } = await run(list);
    const failed = items.filter((i) => i.status === 'failed');
    expect(failed.map((i) => i.message)).toEqual(['bad_name', 'bad_name', 'bad_name']);
    expect(new Set(failed.map((i) => i.path)).size).toBe(3); // two clean to the same name: the entry's index keeps the rows apart
    expect(failed.every((i) => !/[\u0000-\u001f]/.test(i.path))).toBe(true);
    expect(items.find((i) => i.path === 'a.md')?.status).toBe('pending');
    expect(result).toMatchObject({ failed: 3 });
  });

  it('a second entry whose NFC lower-cased path equals an earlier one is skipped as duplicate_path, and the first is kept', async () => {
    const { items, result } = await run(entries('Notes.md', 'notes.md', 'caf\u00e9.md', 'cafe\u0301.md'));
    expect(items.filter((i) => i.status === 'skipped').map((i) => i.message)).toEqual(['duplicate_path', 'duplicate_path']);
    expect(items.find((i) => i.path === 'Notes.md')?.status).toBe('pending');
    expect(items.find((i) => i.path === 'caf\u00e9.md')?.status).toBe('pending');
    expect(result).toMatchObject({ pagesTotal: 2, skipped: 2 });
  });

  it('a nested archive is skipped as nested_archive unless nested archives are allowed, when it is an attachment candidate', async () => {
    expect((await run(entries('a.md', 'inner.zip'))).byPath('inner.zip')).toMatchObject({ status: 'skipped', message: 'nested_archive' });
    expect((await run(entries('a.md', 'inner.ZIP'), { allowNestedZips: true })).byPath('inner.ZIP')).toMatchObject({ kind: 'attachment', status: 'pending' });
  });
});

describe('pages get their ids now, and a folder with no page of its own gets an empty container page', () => {
  it('every pending page item has a page id and a URL id before any page is written', async () => {
    const { items } = await run(entries('a.md', 'dir/b.md'));
    for (const i of items.filter((x) => x.kind === 'page')) expect(i.pageId !== null && i.urlId !== null).toBe(true);
  });

  it('dir/ is a container page when dir has pages but no index.md or README.md, and not when it has one', async () => {
    const without = await run(entries('dir/a.md', 'dir/b.md'));
    expect(without.byPath('dir/')).toMatchObject({ kind: 'page', status: 'pending' });
    const withIndex = await run(entries('dir/index.md', 'dir/b.md'));
    expect(withIndex.byPath('dir/')).toBeUndefined();
    const withReadme = await run(entries('dir/README.md', 'dir/b.md'));
    expect(withReadme.byPath('dir/')).toBeUndefined();
  });

  it('every folder above a page that has no page of its own is a container, and one with an index is not duplicated by a container', async () => {
    const { items } = await run(entries('a/b/c/x.md', 'a/index.md', 'a/b/index.md'));
    expect(items.filter((i) => i.path.endsWith('/') && i.kind === 'page').map((i) => i.path)).toEqual(['a/b/c/']);
  });

  it('a folder that holds only attachments is no container: nothing to put under it', async () => {
    const { items } = await run(entries('img/cat.png', 'a.md'));
    expect(items.some((i) => i.path === 'img/')).toBe(false);
  });

  it('the directory entry of a folder that becomes a container is that container, not an ignored row beside it', async () => {
    const { items } = await run(entries('dir/', 'dir/a.md'));
    const rows = items.filter((i) => i.path === 'dir/');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'page', status: 'pending' });
  });

  it('folders are the same folder when they differ only by case or by NFC/NFD, as duplicate detection says: one container, or the index page', async () => {
    const withIndex = await run(entries('Dir/index.md', 'dir/b.md'));
    expect(withIndex.items.some((i) => i.path.endsWith('/'))).toBe(false); // b.md goes under the index page, no container
    const two = await run(entries('Dir/a.md', 'dir/b.md'));
    expect(two.items.filter((i) => i.path.endsWith('/')).map((i) => i.path)).toEqual(['Dir/']); // one container, under the first spelling
    expect(two.result).toMatchObject({ ok: true, pagesTotal: 3 });
    const nfc = await run(entries('caf\u00e9/a.md', 'cafe\u0301/b.md'));
    expect(nfc.items.filter((i) => i.path.endsWith('/'))).toHaveLength(1);
    expect(nfc.result).toMatchObject({ pagesTotal: 3 });
  });

  it('the directory entry of a container folder is that container whatever its case', async () => {
    const { items } = await run(entries('DIR/', 'dir/a.md'));
    expect(items.filter((i) => i.path.toLowerCase() === 'dir/')).toHaveLength(1);
    expect(items.find((i) => i.path.toLowerCase() === 'dir/')).toMatchObject({ kind: 'page', status: 'pending' });
  });

  it('a directory entry without its trailing slash is the container too, not an ignored row beside it', async () => {
    const { items, result } = await run([entry('dir', { index: 0, isDirectory: true }), entry('dir/a.md', { index: 1 })]);
    expect(items.filter((i) => i.path.replace(/\/$/, '') === 'dir')).toHaveLength(1);
    expect(result).toMatchObject({ skipped: 0, pagesTotal: 2 });
  });

  it('a directory entry named like an index file is not an index file', async () => {
    const { items } = await run([entry('dir/index.md/', { index: 0, isDirectory: true }), entry('dir/b.md', { index: 1 })]);
    expect(items.some((i) => i.path === 'dir/' && i.kind === 'page')).toBe(true); // dir has no page of its own: a container
  });

  it('NFD and upper-case folder names find their index and README like any other', async () => {
    const { items } = await run(entries('cafe\u0301/Index.md', 'cafe\u0301/README.md', 'CAF\u00c9/b.md'));
    expect(items.some((i) => i.path.endsWith('/') && i.kind === 'page')).toBe(false);
    // Index.md is the folder's page, so README.md is an ordinary page inside it, not a second page standing for the folder.
    const lower = new Set(['cafe\u0301/index.md', 'cafe\u0301/readme.md', 'caf\u00e9/b.md'].map((x) => x.normalize('NFC')));
    expect(markdownProfile.folderPathOf('cafe\u0301/README.md', lower)).toBeUndefined();
    expect(markdownProfile.parentPathOf('cafe\u0301/README.md', lower)).toBe('cafe\u0301');
  });

  it('a README beside a directory entry named index.md is its folder\'s page, since only a file is an index file', async () => {
    const { items } = await run([entry('dir/index.md/', { index: 0, isDirectory: true }), entry('dir/README.md', { index: 1 })]);
    expect(items.some((i) => i.path === 'dir/')).toBe(false);
  });

  it('a generated row for a bad name or a duplicate never takes the path of a real entry', async () => {
    const real = 'A.md [entry 1]';
    const list = [entry('a.md', { index: 0 }), entry('A.md', { index: 1 }), entry(real, { index: 2 })];
    const { items, result } = await run(list);
    expect(items.filter((i) => i.path === real)).toHaveLength(1);
    expect(items.find((i) => i.path === real)?.status).toBe('pending'); // the real entry is the one that is imported as a file
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.path)).size).toBe(3);
    expect(result).toMatchObject({ skipped: 1 });
  });

  it('the spellings of a folder do not push an archive over the cap', async () => {
    const list = entries('Dir/a.md', 'dir/b.md', 'DIR/c.md');
    expect((await run(list, { maxPages: 4 })).result).toMatchObject({ ok: true, pagesTotal: 4 });
  });

  it('a README beside an index.md is an ordinary page of the folder, which has the index as its page', async () => {
    const { items } = await run(entries('dir/index.md', 'dir/README.md'));
    expect(items.some((i) => i.path === 'dir/')).toBe(false);
    expect(items.filter((i) => i.kind === 'page')).toHaveLength(2);
  });
});

describe('R10.15: the collection cap', () => {
  it('an archive with more pages than the cap is refused before any item is added, with the counts', async () => {
    const list = Array.from({ length: 5 }, (_, i) => entry(`p${String(i)}.md`, { index: i }));
    const { result, items } = await run(list, { maxPages: 4 });
    expect(result).toEqual({ ok: false, reason: 'collection_full', pagesTotal: 5 });
    expect(items).toEqual([]);
  });

  it('the first example of R10.15: 10,001 pages into the default cap are refused before any item exists, 10,000 are accepted', async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => entry(`p${String(i)}.md`, { index: i }));
    const refused = await run(make(10_001), { maxPages: 10_000 });
    expect(refused.result).toEqual({ ok: false, reason: 'collection_full', pagesTotal: 10_001 });
    expect(refused.items).toEqual([]);
    expect((await run(make(10_000), { maxPages: 10_000 })).result).toMatchObject({ ok: true, pagesTotal: 10_000 });
  });

  it('the second example: 20 pages fit the cap on their own, so pass one accepts them whatever the collection already holds; each write answers collection_full (the page transaction tests)', async () => {
    // Pass one does not know how many pages the collection has: 9,990 live pages and these 20 are decided one write at a time, 10 created and 10 failed `collection_full`.
    const list = Array.from({ length: 20 }, (_, i) => entry(`p${String(i)}.md`, { index: i }));
    const { result, items } = await run(list, { maxPages: 10_000 });
    expect(result).toMatchObject({ ok: true, pagesTotal: 20 });
    expect(items.filter((i) => i.status === 'pending')).toHaveLength(20);
  });

  it('exactly the cap is accepted (container pages count)', async () => {
    expect((await run(entries('d/a.md', 'd/b.md', 'c.md'), { maxPages: 4 })).result).toMatchObject({ ok: true, pagesTotal: 4 });
    expect((await run(entries('d/a.md', 'd/b.md', 'c.md'), { maxPages: 3 })).result).toEqual({ ok: false, reason: 'collection_full', pagesTotal: 4 });
  });
});

describe('resuming', () => {
  it('running pass one again adds nothing: every path is already there', async () => {
    const repo = new FakeImportRepo();
    const made = repo.seed({ id: 'imp', tenantId: 't', status: 'running' });
    const list = entries('a.md', 'dir/b.md', '__MACOSX/x', 'img/c.png');
    await passOne(repo, 't', made.id, list, OPTIONS);
    const first = await repo.scanItems('t', made.id, { limit: 100 });
    await passOne(repo, 't', made.id, list, OPTIONS);
    const second = await repo.scanItems('t', made.id, { limit: 100 });
    expect(second).toEqual(first);
  });

  it('adds in batches of 500 (1,200 entries make three calls)', async () => {
    const repo = new FakeImportRepo();
    const made = repo.seed({ id: 'imp', tenantId: 't', status: 'running' });
    const calls: number[] = [];
    const add = repo.addItems.bind(repo);
    repo.addItems = (tenant, id, items) => { calls.push(items.length); return add(tenant, id, items); };
    await passOne(repo, 't', made.id, Array.from({ length: 1200 }, (_, i) => entry(`f${String(i)}.png`, { index: i })), OPTIONS);
    expect(calls).toEqual([500, 500, 200]);
  });
});
