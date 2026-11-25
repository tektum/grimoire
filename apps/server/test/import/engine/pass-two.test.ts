import { describe, expect, it, vi } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import type { WriteImportedPageResult } from '@tektum/grimoire-core/ports/import-repo';
import { passOne, passTwo } from '../../../src/import/engine.js';
import { markdownProfile } from '../../../src/import/markdown-profile.js';
import { importFailedKey } from '../../../src/import/keys.js';
import { openArchive } from '../../../src/import/zip-reader.js';
import { SegmentStore } from '../hostile/segment-store.js';
import { buildSegments } from '../hostile/zip-builder.js';
import type { BuilderEntry } from '../hostile/zip-builder.js';

// Pass two without attachments (M7 contracts section 4, stage 4a to 4c, 4e): read, decode, preprocess, rewrite, convert, write, one page at a time, parents before children.
const TENANT = 't';
const LIMITS = { maxStateBytes: 1_536_000, seedMaxMarkdownBytes: 128 * 1024 };
const PAGE_LIMITS = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
const text = (s: string) => new TextEncoder().encode(s);
const md = (s: string) => ({ name: s.split('\u0000')[0] as string, data: Buffer.from(s.split('\u0000')[1] ?? '') });

/** A converter that round-trips: the state is the Markdown's bytes, so what is stored shows what the engine handed over. */
class EchoConverter implements MarkdownConverter {
  seedCalls: string[] = [];
  seedScript: ((markdown: string) => SeedResult | undefined) | undefined;
  convertScript: ((state: Uint8Array) => ConvertResult | undefined) | undefined;
  seed(markdown: string): Promise<SeedResult> {
    this.seedCalls.push(markdown);
    return Promise.resolve(this.seedScript?.(markdown) ?? { ok: true, state: text(markdown.length === 0 ? ' ' : markdown) });
  }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> {
    const scripted = this.convertScript?.(state);
    const markdown = new TextDecoder().decode(state).replace(/^ $/, '');
    return Promise.resolve(scripted ?? { ok: true, markdown, text: markdown });
  }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

const ordering = { between: (before: string | null) => `${before ?? ''}a`, isValidPosition: () => true };

async function setup(entries: readonly BuilderEntry[], over: { converter?: EchoConverter; repo?: FakeImportRepo; limits?: Partial<typeof LIMITS> } = {}) {
  const store = new SegmentStore(buildSegments(entries as BuilderEntry[]));
  const opened = await openArchive(store, 'imports/x.zip', store.size, defaultImportConfig);
  if (opened.kind !== 'ok') throw new Error(`refused: ${opened.reason}`);
  const repo = over.repo ?? new FakeImportRepo();
  repo.seed({ id: 'imp', tenantId: TENANT, status: 'running', createdBy: 'user-1', targetCollectionId: 'col' });
  const files = new FakeFileStorage();
  const converter = over.converter ?? new EchoConverter();
  const openEntry = vi.fn(opened.reader.openEntry.bind(opened.reader));
  await passOne(repo, TENANT, 'imp', opened.entries, { profile: markdownProfile, allowNestedZips: false, maxPages: 10_000 });
  const deps = {
    repo, files, converter, profile: markdownProfile, ordering, reader: { openEntry }, entries: opened.entries, limits: { ...defaultImportConfig, ...LIMITS, ...over.limits }, pageLimits: PAGE_LIMITS, now: () => 1_700_000_000_000,
  };
  const run = async (options?: Parameters<typeof passTwo>[2]) => {
    const record = await repo.get(TENANT, 'imp');
    if (record === undefined) throw new Error('no import');
    return passTwo(deps, record, options);
  };
  const items = () => repo.scanItems(TENANT, 'imp', { limit: 1000 });
  return { repo, files, converter, openEntry, run, items, byPath: async (p: string) => (await items()).find((i) => i.path === p) };
}

describe('writing pages in the order of the tree', () => {
  it('a page goes under its folder\'s page, a folder without a page is an empty container, and parents are written before children', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('dir/index.md\u0000# Dir\n'), md('dir/b.md\u0000# B\n'), md('dir/sub/c.md\u0000# C\n')]);
    const result = await t.run();
    expect(result.kind).toBe('done');
    const items = await t.items();
    const id = (p: string) => items.find((i) => i.path === p)?.pageId;
    const written = t.repo.written.map((w) => ({ title: w.page.title, parent: w.page.parentId, collection: w.page.collectionId, by: w.page.createdBy }));
    const byTitle = (title: string) => t.repo.written.find((w) => w.page.title === title)?.page;
    expect(byTitle('A')?.parentId).toBeNull();
    expect(byTitle('Dir')?.parentId).toBeNull();
    expect(byTitle('B')?.parentId).toBe(id('dir/index.md'));
    const container = t.repo.written.find((w) => w.page.title === 'sub')?.page;
    expect(container?.parentId).toBe(id('dir/index.md'));
    expect(byTitle('C')?.parentId).toBe(id('dir/sub/'));
    expect(written.every((w) => w.collection === 'col' && w.by === 'user-1')).toBe(true);
    // Parents before children, whatever the order of the paths: the index page is written before dir/b.md although 'dir/b.md' sorts first.
    const order = t.repo.written.map((w) => w.page.title);
    expect(order.indexOf('Dir')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('sub')).toBeLessThan(order.indexOf('C'));
  });

  it('siblings are placed one after the other in the order of their paths', async () => {
    const t = await setup([md('b.md\u0000# B\n'), md('a.md\u0000# A\n'), md('c.md\u0000# C\n')]);
    await t.run();
    const positions = t.repo.written.map((w) => [w.page.title, w.position]);
    const sorted = [...positions].sort((x, y) => (x[1] as string) < (y[1] as string) ? -1 : 1).map((x) => x[0]);
    expect(sorted).toEqual(['A', 'B', 'C']);
  });

  it('each page is written under the page id and URL id its item was given, with the canonical Markdown the converter made', async () => {
    const t = await setup([md('a.md\u0000*one*  text\n')]);
    await t.run();
    const item = await t.byPath('a.md');
    expect(item).toMatchObject({ status: 'ok' });
    expect(t.repo.written[0]?.page.content.markdown).toBe('*one*  text\n');
    expect(t.repo.written[0]?.page.markdownBytes).toBe(Buffer.byteLength('*one*  text\n'));
  });

  it('the title is the first heading, else the file name; a container is named by its folder; a long title is cut to 255 characters with a warning', async () => {
    const long = `# ${'x'.repeat(300)}\n`;
    const t = await setup([md('plain note.md\u0000just text\n'), md('d/e.md\u0000# E\n'), md(`long.md\u0000${long}`)]);
    const result = await t.run();
    const titles = new Set(t.repo.written.map((w) => w.page.title));
    expect(titles.has('plain note')).toBe(true);
    expect(titles.has('d')).toBe(true);
    expect(titles.has('x'.repeat(255))).toBe(true);
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });
});

describe('links', () => {
  it('a link to a page of the archive becomes /p/<url_id> with its fragment, and one that matches nothing stays as written and is a warning', async () => {
    const t = await setup([md('a.md\u0000[b](dir/b.md#part) [gone](missing.md)\n'), md('dir/b.md\u0000# B\n')]);
    const result = await t.run();
    const b = await t.byPath('dir/b.md');
    const a = t.repo.written.find((w) => w.page.title === 'a')?.page;
    expect(a?.content.markdown).toBe(`[b](/p/${b?.urlId as string}#part) [gone](missing.md)\n`);
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });

  it('a link to a page that was skipped or failed is left as written: there is no page to point at', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000[a](a.md)\n')]);
    t.converter.seedScript = (m) => (m.startsWith('# A') ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : undefined);
    await t.run();
    expect(t.repo.written.find((w) => w.page.title === 'b')?.page.content.markdown).toBe('[a](a.md)\n');
  });
});

describe('what is not written', () => {
  it('an entry that is not valid UTF-8 is a failed item invalid_encoding: no page, and the converter never sees it', async () => {
    const t = await setup([{ name: 'bad.md', data: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) }, md('ok.md\u0000# Ok\n')]);
    await t.run();
    expect(await t.byPath('bad.md')).toMatchObject({ status: 'failed', message: 'invalid_encoding', pageId: null });
    expect(t.converter.seedCalls).toEqual(['# Ok\n']);
  });

  it('a Markdown entry above the seed cap is skipped too_large without being opened, and the import goes on', async () => {
    const t = await setup([{ name: 'big.md', data: Buffer.alloc(2000, 0x61) }, md('ok.md\u0000# Ok\n')], { limits: { seedMaxMarkdownBytes: 1000 } });
    await t.run();
    expect(await t.byPath('big.md')).toMatchObject({ status: 'skipped', message: 'too_large', markdownBytes: 2000 });
    expect(t.openEntry).toHaveBeenCalledTimes(1); // only ok.md was opened
  });

  it('an entry that holds more than it declares is a failed item size_mismatch', async () => {
    const t = await setup([{ name: 'lie.md', data: Buffer.alloc(500, 0x61), declaredSize: 10 }, md('ok.md\u0000# Ok\n')]);
    await t.run();
    expect(await t.byPath('lie.md')).toMatchObject({ status: 'failed', message: 'size_mismatch' });
    expect((await t.byPath('ok.md'))?.status).toBe('ok');
  });

  it.each([['invalid-markdown'], ['timeout'], ['internal']] as const)('a page the converter refuses as %s is a failed item with that reason, no page, and its original Markdown is kept for download', async (reason) => {
    const t = await setup([md('p.md\u0000# Original [x](y)\n')]);
    t.converter.seedScript = () => ({ ok: false, reason, detail: 'x' });
    await t.run();
    const item = await t.byPath('p.md');
    expect(item).toMatchObject({ status: 'failed', message: reason, pageId: null });
    expect(t.repo.written).toEqual([]);
    const stored = await t.files.get(importFailedKey(TENANT, 'imp', item?.id as string));
    const chunks: Uint8Array[] = [];
    for await (const c of stored.body) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('# Original [x](y)\n'); // the original, not the rewritten one
  });

  it('a loss class on the way back (content-lost) and a state over the cap are failed items with their sources kept; a page too large to seed is skipped, with no source', async () => {
    const t = await setup([md('lost.md\u0000L\n'), md('huge.md\u0000H\n'), md('seed.md\u0000S\n')], { limits: { maxStateBytes: 100 } });
    t.converter.convertScript = (state) => (new TextDecoder().decode(state) === 'L\n' ? { ok: false, reason: 'content-lost', detail: 'x' } : undefined);
    t.converter.seedScript = (m) => (m === 'H\n' ? { ok: true, state: new Uint8Array(101) } : m === 'S\n' ? { ok: false, reason: 'too-large', detail: 'x' } : undefined);
    await t.run();
    expect(await t.byPath('lost.md')).toMatchObject({ status: 'failed', message: 'content-lost' });
    expect(await t.byPath('huge.md')).toMatchObject({ status: 'failed', message: 'state_too_large', stateBytes: 101 });
    expect(await t.byPath('seed.md')).toMatchObject({ status: 'skipped', message: 'too-large-to-seed' });
    const keys = (await t.files.list('tenants/')).items.map((i) => i.key);
    expect(keys).toHaveLength(2);
  });

  it('a failed parent does not take its children with it: they go under the nearest page that was written', async () => {
    const t = await setup([md('dir/index.md\u0000# Dir\n'), md('dir/b.md\u0000# B\n')]);
    t.converter.seedScript = (m) => (m.startsWith('# Dir') ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : undefined);
    await t.run();
    expect(await t.byPath('dir/index.md')).toMatchObject({ status: 'failed' });
    expect(t.repo.written.find((w) => w.page.title === 'B')?.page.parentId).toBeNull();
  });
});

describe('what the page write refuses', () => {
  const refusing = (kind: Exclude<WriteImportedPageResult['kind'], 'ok'>) => {
    const repo = new FakeImportRepo();
    repo.writePage = () => Promise.resolve({ kind });
    return repo;
  };

  it.each([['collection-full', 'collection_full'], ['tenant-pages-full', 'tenant_pages_full'], ['too-deep', 'too_deep']] as const)('%s is a failed item %s and the import goes on', async (kind, message) => {
    const t = await setup([md('a.md\u0000# A\n')], { repo: refusing(kind) });
    const result = await t.run();
    expect(await t.byPath('a.md')).toMatchObject({ status: 'failed', message });
    expect(result.kind).toBe('done');
  });

  it('a collection that is gone ends the run: nothing more can be written, and the item stays pending', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')], { repo: refusing('collection-deleted') });
    const result = await t.run();
    expect(result).toMatchObject({ kind: 'stopped', reason: 'collection_deleted' });
    expect((await t.byPath('a.md'))?.status).toBe('pending');
  });

  it('an import that is no longer running stops the run: the page is not written', async () => {
    const t = await setup([md('a.md\u0000# A\n')], { repo: refusing('not-running') });
    expect(await t.run()).toMatchObject({ kind: 'stopped', reason: 'not_running' });
  });

  it('an item that was settled by someone else meanwhile is skipped over, not an error, and what it became is read back: written counts as a page, failed does not', async () => {
    // The write is refused as not-pending because another run wrote the page between this run's read of the items and its write: the page exists, so it counts.
    const written = await setup([md('a.md\u0000# A\n')]);
    const wItem = await written.byPath('a.md');
    const real = written.repo.writePage.bind(written.repo);
    written.repo.writePage = async (...args) => {
      await real(args[0], args[1], { ...args[2], position: () => 'a' }); // the other run's write
      return { kind: 'not-pending' };
    };
    expect(await written.run()).toMatchObject({ kind: 'done', counts: { pagesDone: 1 } });
    expect(wItem?.status).toBe('pending');
    expect((await written.byPath('a.md'))?.status).toBe('ok');

    // The other run failed the item instead: it does not count as a page, and a child does not get its stale page id as a parent.
    const failed = await setup([md('a/index.md\u0000# A\n'), md('a/child.md\u0000# C\n')]);
    const fItem = await failed.byPath('a/index.md');
    const realFailed = failed.repo.writePage.bind(failed.repo);
    failed.repo.writePage = async (...args) => {
      if (args[2].itemId === fItem?.id) { await failed.repo.settle(TENANT, 'imp', fItem.id, { status: 'failed', message: 'internal' }); return { kind: 'not-pending' }; }
      return realFailed(...args);
    };
    const second = await failed.run();
    expect(second).toMatchObject({ kind: 'done', counts: { pagesDone: 1, failed: 1 } });
    expect(failed.repo.written.find((w) => w.page.title === 'C')?.page.parentId).toBeNull();
  });

  it('warnings are kept on the rows: a run interrupted after a write and before its counts were saved loses none on resume', async () => {
    const t = await setup([md('a.md\u0000[x](nope.md)\n'), md('b.md\u0000# B\n')]);
    // The first run writes a.md (one warning) and stops before saving any counts, as a crash would.
    const real = t.repo.setCounts.bind(t.repo);
    t.repo.setCounts = () => Promise.resolve(true);
    t.converter.seedScript = (m) => { if (m === '# B\n') throw new Error('crash'); return undefined; };
    await expect(t.run()).rejects.toThrow('crash');
    t.repo.setCounts = real;
    t.converter.seedScript = undefined;
    const resumed = await t.run();
    expect(resumed).toMatchObject({ kind: 'done', counts: { pagesDone: 2, warnings: 1 } });
  });

  it('a settle that lost the race counts none of this run\'s warnings', async () => {
    const t = await setup([md('a.md\u0000[x](nope.md)\n')]);
    t.converter.seedScript = () => ({ ok: false, reason: 'invalid-markdown', detail: 'x' });
    const item = await t.byPath('a.md');
    const real = t.repo.settle.bind(t.repo);
    t.repo.settle = async (tenant, id, itemId, outcome) => { if (itemId === item?.id) await real(tenant, id, itemId, { status: 'skipped', message: 'ignored' }); return real(tenant, id, itemId, outcome); };
    expect(await t.run()).toMatchObject({ kind: 'done', counts: { warnings: 0, failed: 0, skipped: 1 } });
  });

  it('an item whose settle is refused because another run settled it first takes the status that run gave it', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')]);
    t.converter.seedScript = (m) => (m.startsWith('# A') ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : undefined);
    const item = await t.byPath('a.md');
    const real = t.repo.settle.bind(t.repo);
    t.repo.settle = async (tenant, id, itemId, outcome) => { if (itemId === item?.id) { await real(tenant, id, itemId, { status: 'skipped', message: 'ignored' }); } return real(tenant, id, itemId, outcome); };
    const result = await t.run();
    expect(result).toMatchObject({ kind: 'done', counts: { failed: 0, skipped: 1, pagesDone: 1 } });
  });
});

describe('batches, cancelling and resuming', () => {
  it('the import is read again before each batch of pages: a cancel stops the run at the next batch', async () => {
    const t = await setup(['a', 'b', 'c', 'd', 'e'].map((n) => md(`${n}.md\u0000# ${n}\n`)));
    // Reads of the import: the test's own, then one before each batch; the third (before the second batch) finds it cancelled.
    const real = t.repo.get.bind(t.repo);
    let reads = 0;
    t.repo.get = async (tenant, id) => { reads++; const record = await real(tenant, id); return reads >= 3 && record !== undefined ? { ...record, status: 'cancelled' } : record; };
    const result = await t.run({ batchPages: 2 });
    expect(result).toMatchObject({ kind: 'stopped', reason: 'not_running' });
    expect(t.repo.written.map((w) => w.page.title)).toEqual(['a', 'b']); // the first batch finished, the second never started
  });

  it('a batch ends at the byte budget as well as at the page count', async () => {
    const t = await setup(['a', 'b', 'c'].map((n) => md(`${n}.md\u0000${'x'.repeat(600)}\n`)));
    const reads = vi.spyOn(t.repo, 'get');
    await t.run({ batchPages: 25, batchBytes: 1000 });
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3); // 2 pages fit in a budget of 1,000 bytes only until the second pushes it over
  });

  it('running it again after it finished writes nothing and gives the same counts', async () => {
    const t = await setup([md('a.md\u0000# A [b](b.md)\n'), md('b.md\u0000# B\n')]);
    const first = await t.run();
    const writes = t.repo.written.length;
    const second = await t.run();
    expect(t.repo.written).toHaveLength(writes);
    expect(second).toEqual(first);
  });

  it('resumes from the pending items: pages written before an interruption are not written again and links to them still resolve', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('c.md\u0000[a](a.md) [b](b.md)\n'), md('b.md\u0000# B\n')]);
    const aId = (await t.byPath('a.md'))?.id as string;
    await t.repo.writePage(TENANT, 'imp', { itemId: aId, collectionId: 'col', parentId: null, position: () => 'a', title: 'A', createdBy: 'user-1', content: { state: new Uint8Array(1), markdown: '# A\n', text: 'A', hash: Buffer.alloc(32) }, markdownBytes: 4, stateBytes: 1, attachments: [] });
    const result = await t.run();
    expect(result.kind).toBe('done');
    expect(t.repo.written.filter((w) => w.page.itemId === aId)).toHaveLength(1);
    const c = t.repo.written.find((w) => w.page.title === 'c')?.page;
    expect(c?.content.markdown).toMatch(/^\[a\]\(\/p\/[^)]+\) \[b\]\(\/p\/[^)]+\)\n$/);
  });

  it('warnings of a page that stays pending are not counted, so a busy retry does not count them twice', async () => {
    const t = await setup([md('a.md\u0000[x](nope.md)\n')]);
    let busy = true;
    t.converter.seedScript = () => (busy ? { ok: false, reason: 'internal', detail: 'queue-full' } : undefined);
    expect(await t.run()).toMatchObject({ kind: 'busy', counts: { warnings: 0 } });
    expect((await t.repo.get(TENANT, 'imp'))?.counts.warnings).toBe(0);
    busy = false;
    expect(await t.run()).toMatchObject({ kind: 'done', counts: { warnings: 1 } });
  });

  it('a busy converter ends the run with the item still pending: the caller tries again later', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')]);
    t.converter.seedScript = () => ({ ok: false, reason: 'internal', detail: 'queue-full' });
    const result = await t.run();
    expect(result).toMatchObject({ kind: 'busy' });
    expect((await t.byPath('a.md'))?.status).toBe('pending');
    expect(t.repo.written).toEqual([]);
  });

  it('the abort signal ends the run before the next batch', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')]);
    const controller = new AbortController();
    t.converter.seedScript = () => { controller.abort(); return undefined; };
    const result = await t.run({ batchPages: 1, signal: controller.signal });
    expect(result).toMatchObject({ kind: 'stopped', reason: 'aborted' });
    expect(t.repo.written).toHaveLength(1);
  });
});

describe('the counts', () => {
  it('are written after each batch and returned: pages done, skipped, failed and warnings', async () => {
    const t = await setup([md('a.md\u0000[x](nope.md)\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')]);
    t.converter.seedScript = (m) => (m.startsWith('# C') ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : undefined);
    const result = await t.run();
    expect(result).toMatchObject({ kind: 'done', counts: { pagesDone: 2, failed: 1, warnings: 1 } });
    expect((await t.repo.get(TENANT, 'imp'))?.counts).toMatchObject({ pagesDone: 2, failed: 1, warnings: 1 });
  });
});
