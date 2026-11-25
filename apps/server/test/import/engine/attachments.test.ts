import { describe, expect, it } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { passOne, passTwo } from '../../../src/import/engine.js';
import { markdownProfile } from '../../../src/import/markdown-profile.js';
import { openArchive } from '../../../src/import/zip-reader.js';
import { sniffType } from '../../../src/attachments/deps.js';
import { SegmentStore } from '../hostile/segment-store.js';
import { buildSegments } from '../hostile/zip-builder.js';
import type { BuilderEntry } from '../hostile/zip-builder.js';

// Stage 4d (M7 contracts section 4): the files a page uses become attachments of that page, before the page is written; what cannot be one leaves its link as written.
const TENANT = 't';
const ALLOWED = ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv'];
const text = (s: string) => new TextEncoder().encode(s);
const md = (s: string) => ({ name: s.split('\u0000')[0] as string, data: Buffer.from(s.split('\u0000')[1] ?? '') });

/** A PNG that `file-type` recognises: the signature and an IHDR chunk. */
function png(extra = 0): Buffer {
  const crc = Buffer.alloc(4);
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), crc]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra, 7)]);
}

/** A PDF `file-type` recognises: its check reads well past the header, so the body is padded. */
const pdf = (): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1600, 0x20), Buffer.from('\n%%EOF\n')]);

class EchoConverter implements MarkdownConverter {
  fail: ((markdown: string) => boolean) | undefined;
  seed(markdown: string): Promise<SeedResult> {
    return Promise.resolve(this.fail?.(markdown) === true ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : { ok: true, state: text(markdown.length === 0 ? ' ' : markdown) });
  }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> {
    const markdown = new TextDecoder().decode(state).replace(/^ $/, '');
    return Promise.resolve({ ok: true, markdown, text: markdown });
  }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

const ordering = { between: (before: string | null) => `${before ?? ''}a` };

async function setup(entries: readonly BuilderEntry[], over: { filesMaxBytes?: number; files?: FakeFileStorage; converter?: EchoConverter } = {}) {
  const store = new SegmentStore(buildSegments(entries as BuilderEntry[]));
  const opened = await openArchive(store, 'imports/x.zip', store.size, defaultImportConfig);
  if (opened.kind !== 'ok') throw new Error(`refused: ${opened.reason}`);
  const repo = new FakeImportRepo();
  repo.seed({ id: 'imp', tenantId: TENANT, status: 'running', createdBy: 'user-1', targetCollectionId: 'col' });
  const files = over.files ?? new FakeFileStorage();
  const converter = over.converter ?? new EchoConverter();
  await passOne(repo, TENANT, 'imp', opened.entries, { profile: markdownProfile, allowNestedZips: false, maxPages: 10_000 });
  const deps = {
    repo, files, converter, profile: markdownProfile, ordering, reader: opened.reader, entries: opened.entries, now: () => 1_700_000_000_000,
    limits: { ...defaultImportConfig, seedMaxMarkdownBytes: 128 * 1024, maxStateBytes: 1_536_000 },
    pageLimits: { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 },
    attachments: { maxBytes: over.filesMaxBytes ?? 25 * 1024 * 1024, allowedTypes: ALLOWED, sniff: sniffType },
  };
  const run = async () => { const record = await repo.get(TENANT, 'imp'); if (record === undefined) throw new Error('no import'); return passTwo(deps, record); };
  const items = () => repo.scanItems(TENANT, 'imp', { limit: 1000 });
  const byPath = async (p: string) => (await items()).find((i) => i.path === p);
  const bytesOf = async (key: string): Promise<Buffer> => { const chunks: Uint8Array[] = []; for await (const c of (await files.get(key)).body) chunks.push(c); return Buffer.concat(chunks); };
  return { repo, files, converter, run, items, byPath, bytesOf };
}

const page = (t: Awaited<ReturnType<typeof setup>>, title: string) => t.repo.written.find((w) => w.page.title === title)?.page;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a file a page uses becomes an attachment of that page', () => {
  it('an image becomes attachments/<id>/<name> with a ready row owned by the page, the object stored under the tenant, and the item ok', async () => {
    const image = png();
    const t = await setup([md('a.md\u0000# A\n\n![cat](img/my%20cat.png) and [doc](doc.pdf#page=2)\n'), { name: 'img/my cat.png', data: image }, { name: 'doc.pdf', data: pdf() }]);
    const result = await t.run();
    expect(result.kind).toBe('done');
    const a = page(t, 'A');
    expect(a?.attachments).toHaveLength(2);
    const cat = a?.attachments.find((x) => x.fileName === 'my cat.png');
    expect(cat).toMatchObject({ uploaderId: 'user-1', contentType: 'image/png', size: image.length, readyAt: 1_700_000_000_000 });
    expect(cat?.id).toMatch(UUID_V5);
    expect(cat?.key).toBe(`tenants/${TENANT}/attachments/${cat?.id as string}`);
    expect(a?.content.markdown).toContain(`![cat](attachments/${cat?.id as string}/my%20cat.png)`);
    expect(a?.content.markdown).toMatch(/\[doc\]\(attachments\/[0-9a-f-]{36}\/doc\.pdf\)/); // the fragment is dropped for a file
    expect(await t.bytesOf(cat?.key as string)).toEqual(image);
    expect((await t.byPath('img/my cat.png'))?.status).toBe('ok');
    expect(result.kind === 'done' && result.counts.attachments).toBe(2);
  });

  it('the id is deterministic (a v5 of import, page and file), so a resumed run puts the same object', async () => {
    const entries = [md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }];
    const one = await setup(entries);
    await one.run();
    const two = await setup(entries);
    await two.run();
    expect(page(one, 'a')?.attachments[0]?.id).toBe(page(two, 'a')?.attachments[0]?.id);
  });

  it('a file used by two pages gives two rows with different ids and two objects, and the file item is ok once', async () => {
    const t = await setup([md('a.md\u0000![x](c.png)\n'), md('b.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }]);
    await t.run();
    const ids = ['a', 'b'].map((n) => page(t, n)?.attachments[0]?.id);
    expect(new Set(ids).size).toBe(2);
    expect((await t.files.list('tenants/')).items).toHaveLength(2);
    expect((await t.byPath('c.png'))?.status).toBe('ok');
  });

  it('the same file twice on one page is one attachment of that page', async () => {
    const t = await setup([md('a.md\u0000![x](c.png) ![y](c.png)\n'), { name: 'c.png', data: png() }]);
    await t.run();
    expect(page(t, 'a')?.attachments).toHaveLength(1);
    const markdown = page(t, 'a')?.content.markdown as string;
    expect(markdown.match(/attachments\//g)).toHaveLength(2);
  });

  it('a file that no page uses is skipped as unreferenced when the run ends, and a page that failed leaves its file unreferenced and its object removed', async () => {
    const t = await setup([md('a.md\u0000# Bad\n![x](c.png)\n'), md('b.md\u0000# Fine\n'), { name: 'c.png', data: png() }, { name: 'lonely.png', data: png() }]);
    (t.converter as EchoConverter).fail = (m) => m.startsWith('# Bad');
    await t.run();
    expect(await t.byPath('lonely.png')).toMatchObject({ status: 'skipped', message: 'unreferenced' });
    expect(await t.byPath('c.png')).toMatchObject({ status: 'skipped', message: 'unreferenced' });
    expect((await t.files.list('tenants/')).items.filter((i) => i.key.includes('/attachments/'))).toEqual([]); // the object put for the failed page is removed
  });
});

describe('a file that cannot be an attachment leaves its link as written, with a warning', () => {
  it('a file over the limit is skipped entry_too_large; the page is still written', async () => {
    const t = await setup([md('a.md\u0000![x](big.png)\n'), { name: 'big.png', data: png(2000) }], { filesMaxBytes: 1000 });
    const result = await t.run();
    expect(await t.byPath('big.png')).toMatchObject({ status: 'skipped', message: 'entry_too_large' });
    expect(page(t, 'a')?.content.markdown).toBe('![x](big.png)\n');
    expect(page(t, 'a')?.attachments).toEqual([]);
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });

  it('a type outside the list is type_not_allowed, and a file whose bytes are not its type is type_mismatch', async () => {
    const t = await setup([md('a.md\u0000![v](v.svg) ![m](fake.png)\n'), { name: 'v.svg', data: Buffer.from('<svg/>') }, { name: 'fake.png', data: Buffer.from('this is text, not a png') }]);
    await t.run();
    expect(await t.byPath('v.svg')).toMatchObject({ status: 'skipped', message: 'type_not_allowed' });
    expect(await t.byPath('fake.png')).toMatchObject({ status: 'skipped', message: 'type_mismatch' });
    expect(page(t, 'a')?.attachments).toEqual([]);
    expect((await t.files.list('tenants/')).items).toEqual([]); // nothing was stored for either
  });

  it('a file that holds more than it declares is failed size_mismatch', async () => {
    const t = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png(300), declaredSize: 40 }]);
    await t.run();
    expect(await t.byPath('c.png')).toMatchObject({ status: 'failed', message: 'size_mismatch' });
  });

  it('a refused file is decided once however many pages use it: every page keeps its link and counts a warning, and the file is read once', async () => {
    const t = await setup([md('a.md\u0000![x](v.svg)\n'), md('b.md\u0000![x](v.svg)\n'), { name: 'v.svg', data: Buffer.from('<svg/>') }]);
    const result = await t.run();
    expect((await t.items()).filter((i) => i.path === 'v.svg')).toHaveLength(1);
    expect(result.kind === 'done' && result.counts.warnings).toBe(2);
  });

  it('a link to a file that is not in the archive is an unresolved link, as before', async () => {
    const t = await setup([md('a.md\u0000![x](nope.png)\n')]);
    const result = await t.run();
    expect(page(t, 'a')?.content.markdown).toBe('![x](nope.png)\n');
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });
});

describe('resuming', () => {
  it('an object that is there from an earlier attempt, of the right size, is accepted: the put is create-only and a 412 is verified', async () => {
    const files = new FakeFileStorage();
    const first = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }], { files });
    await first.run();
    const key = page(first, 'a')?.attachments[0]?.key as string;
    const again = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }], { files });
    const result = await again.run();
    expect(result.kind).toBe('done');
    expect(page(again, 'a')?.attachments[0]?.key).toBe(key);
  });

  it('an object there with another size is not this page\'s file: the link stays, and the file is not failed (another page may use it; with none it is unreferenced)', async () => {
    const files = new FakeFileStorage();
    const probe = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }], { files });
    await probe.run();
    const key = page(probe, 'a')?.attachments[0]?.key as string;
    await files.put(key, Buffer.from('other'), { size: 5, contentType: 'image/png' });
    const again = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }], { files });
    await again.run();
    expect(await again.byPath('c.png')).toMatchObject({ status: 'skipped', message: 'unreferenced' });
    expect(page(again, 'a')?.content.markdown).toBe('![x](c.png)\n');
  });
});

describe('review of the attachments (each written to fail before the fix)', () => {
  it('a file with no bytes is refused before it is staged (the attachments table needs a size above 0): skipped empty_file, the link stays, the page is written', async () => {
    const t = await setup([md('a.md\u0000[e](empty.txt)\n'), { name: 'empty.txt', data: Buffer.alloc(0) }]);
    const result = await t.run();
    expect(await t.byPath('empty.txt')).toMatchObject({ status: 'skipped', message: 'empty_file' });
    expect(page(t, 'a')?.attachments).toEqual([]);
    expect(page(t, 'a')?.content.markdown).toBe('[e](empty.txt)\n');
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });

  it('objects stored for a page are kept when another run has written that page meanwhile (the keys are the same): only a page that is known not to be written loses them', async () => {
    const entries = [md('a.md\u0000# A\n![x](c.png)\n'), { name: 'c.png', data: png() }];
    const t = await setup(entries);
    // This run is refused by the converter, but another run writes the page while it converts: its rows point at the objects this run staged.
    const real = t.repo.writePage.bind(t.repo);
    const item = await t.byPath('a.md');
    t.converter.fail = (markdown) => {
      void real(TENANT, 'imp', { itemId: item?.id as string, collectionId: 'col', parentId: null, position: () => 'a', title: 'A', createdBy: 'user-1', content: { state: new Uint8Array(1), markdown, text: 'A', hash: Buffer.alloc(32) }, markdownBytes: 4, stateBytes: 1, attachments: [] });
      return true;
    };
    await t.run();
    expect((await t.byPath('a.md'))?.status).toBe('ok'); // the other run's write won
    expect((await t.files.list('tenants/')).items.filter((i) => i.key.includes('/attachments/'))).toHaveLength(1); // and the objects it points at are still there
  });

  it('the file items are settled ok in the same call as the page, so a crash right after the write cannot leave a used file to be swept as unreferenced', async () => {
    const t = await setup([md('a.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }]);
    t.repo.settle = () => Promise.reject(new Error('crash after the write')); // nothing that comes after writePage runs
    await t.run().catch(() => undefined); // whatever comes after the write may fail
    expect(page(t, 'a')?.attachments).toHaveLength(1);
    expect((await t.byPath('c.png'))?.status).toBe('ok');
  });

  it('an object that is there for one page with another size fails that page\'s use of the file only: another page still attaches the file, and the file item is not failed', async () => {
    const files = new FakeFileStorage();
    const entries = [md('a.md\u0000![x](c.png)\n'), md('b.md\u0000![x](c.png)\n'), { name: 'c.png', data: png() }];
    const probe = await setup(entries, { files });
    await probe.run();
    const keyOfA = page(probe, 'a')?.attachments[0]?.key as string;
    await files.delete(page(probe, 'b')?.attachments[0]?.key as string);
    await files.put(keyOfA, Buffer.from('stale'), { size: 5, contentType: 'image/png' });
    const again = await setup(entries, { files });
    await again.run();
    expect(page(again, 'a')?.content.markdown).toBe('![x](c.png)\n'); // a keeps its link
    expect(page(again, 'b')?.attachments).toHaveLength(1); // b attaches the same file
    expect((await again.byPath('c.png'))?.status).toBe('ok');
  });
});
