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
