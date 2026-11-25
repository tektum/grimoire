import { describe, expect, it } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { passOne, passTwo } from '../../../src/import/engine.js';
import { markdownProfile } from '../../../src/import/markdown-profile.js';
import { openArchive } from '../../../src/import/zip-reader.js';
import { sniffType } from '../../../src/attachments/deps.js';
import type { RemoteBudget, RemoteImageFetcher, RemoteResult } from '../../../src/import/remote-images/index.js';
import { SegmentStore } from '../hostile/segment-store.js';
import { buildSegments } from '../hostile/zip-builder.js';
import type { BuilderEntry } from '../hostile/zip-builder.js';

// The remote image hook of stage 4d (M7 contracts section 5): an absolute https image is copied into the tool before its page is written; a failure never fails the import.
const TENANT = 't';
const text = (s: string) => new TextEncoder().encode(s);
const md = (s: string) => ({ name: s.split('\u0000')[0] as string, data: Buffer.from(s.split('\u0000')[1] ?? '') });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), Buffer.alloc(4)]);

class EchoConverter implements MarkdownConverter {
  fail: ((markdown: string) => boolean) | undefined;
  seed(markdown: string): Promise<SeedResult> { return Promise.resolve(this.fail?.(markdown) === true ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : { ok: true, state: text(markdown.length === 0 ? ' ' : markdown) }); }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> { const markdown = new TextDecoder().decode(state).replace(/^ $/, ''); return Promise.resolve({ ok: true, markdown, text: markdown }); }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

/** A fetcher that answers from a script and keeps the rules of the real one's budget (it counts a call, and refuses when the images or the time are used up). */
class ScriptedFetcher implements RemoteImageFetcher {
  readonly calls: string[] = [];
  readonly budgets: RemoteBudget[] = [];
  constructor(private readonly script: (url: string) => RemoteResult = () => ok(PNG)) {}
  fetch(url: string, budget: RemoteBudget): Promise<RemoteResult> {
    this.calls.push(url);
    this.budgets.push(budget);
    if (budget.taken >= budget.maxImages) return Promise.resolve({ ok: false, reason: 'budget' });
    budget.taken++;
    return Promise.resolve(this.script(url));
  }
}
const ok = (bytes: Buffer, contentType = 'image/png'): RemoteResult => ({ ok: true, bytes: (async function* () { yield bytes; })(), contentType, size: bytes.length });
const fail = (reason: Extract<RemoteResult, { ok: false }>['reason']): RemoteResult => ({ ok: false, reason });

async function setup(entries: readonly BuilderEntry[], over: { fetcher?: RemoteImageFetcher | undefined; remote?: boolean; maxImages?: number; filesMaxBytes?: number } = {}) {
  const store = new SegmentStore(buildSegments(entries as BuilderEntry[]));
  const opened = await openArchive(store, 'imports/x.zip', store.size, defaultImportConfig);
  if (opened.kind !== 'ok') throw new Error(`refused: ${opened.reason}`);
  const repo = new FakeImportRepo();
  repo.seed({ id: 'imp', tenantId: TENANT, status: 'running', createdBy: 'user-1', targetCollectionId: 'col' });
  const files = new FakeFileStorage();
  const converter = new EchoConverter();
  await passOne(repo, TENANT, 'imp', opened.entries, { profile: markdownProfile, allowNestedZips: false, maxPages: 10_000 });
  const deps = {
    repo, files, converter, profile: markdownProfile, ordering: { between: (b: string | null) => `${b ?? ''}a` }, reader: opened.reader, entries: opened.entries, now: () => 1_700_000_000_000,
    limits: { ...defaultImportConfig, seedMaxMarkdownBytes: 128 * 1024, maxStateBytes: 1_536_000 },
    pageLimits: { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 },
    attachments: { maxBytes: over.filesMaxBytes ?? 25 * 1024 * 1024, allowedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], sniff: sniffType },
    ...(over.remote === false ? {} : { remote: { fetcher: over.fetcher, config: { ...defaultImportConfig.remote, maxImages: over.maxImages ?? 200 } } }),
  };
  const run = async (options?: Parameters<typeof passTwo>[2]) => { const record = await repo.get(TENANT, 'imp'); if (record === undefined) throw new Error('no import'); return passTwo(deps, record, options); };
  const byPath = async (p: string) => (await repo.scanItems(TENANT, 'imp', { limit: 1000 })).find((i) => i.path === p);
  const page = (title: string) => repo.written.find((w) => w.page.title === title)?.page;
  return { repo, files, converter, run, byPath, page };
}

describe('an absolute https image is copied into the tool', () => {
  it('the fetcher is called once with the URL and the budget; on success the image points at a new attachment of the page, stored like an upload', async () => {
    const fetcher = new ScriptedFetcher();
    const t = await setup([md('a.md\u0000# A\n![pic](https://img.example/dir/cat.png?x=1)\n')], { fetcher });
    const result = await t.run();
    expect(fetcher.calls).toEqual(['https://img.example/dir/cat.png?x=1']);
    const a = t.page('A');
    expect(a?.attachments).toHaveLength(1);
    const row = a?.attachments[0];
    expect(row).toMatchObject({ uploaderId: 'user-1', contentType: 'image/png', size: PNG.length, fileName: 'cat.png' });
    expect(row?.key).toBe(`tenants/${TENANT}/attachments/${row?.id as string}`);
    expect(a?.content.markdown).toContain(`![pic](attachments/${row?.id as string}/cat.png)`);
    expect(result.kind === 'done' && result.counts.warnings).toBe(0);
    const stored: Uint8Array[] = [];
    for await (const c of (await t.files.get(row?.key as string)).body) stored.push(c);
    expect(Buffer.concat(stored)).toEqual(PNG);
  });

  it('the same URL twice on one page is fetched once and is one attachment', async () => {
    const fetcher = new ScriptedFetcher();
    const t = await setup([md('a.md\u0000![x](https://img.example/a.png) ![y](https://img.example/a.png)\n')], { fetcher });
    await t.run();
    expect(fetcher.calls).toHaveLength(1);
    expect(t.page('a')?.attachments).toHaveLength(1);
  });

  it('a file name the URL does not give is image plus the extension of the type', async () => {
    const t = await setup([md('a.md\u0000![x](https://img.example/)\n')], { fetcher: new ScriptedFetcher() });
    await t.run();
    expect(t.page('a')?.attachments[0]?.fileName).toMatch(/^image\.png$/);
  });
});

describe('a failure never fails the import', () => {
  it.each(['blocked_address', 'redirect', 'too_large', 'timeout', 'status', 'type', 'budget', 'network'] as const)('%s leaves the link as written and is one warning; the page is written', async (reason) => {
    const t = await setup([md('a.md\u0000# A\n![x](https://img.example/a.png)\n')], { fetcher: new ScriptedFetcher(() => fail(reason)) });
    const result = await t.run();
    expect(t.page('A')?.content.markdown).toBe('# A\n![x](https://img.example/a.png)\n');
    expect(t.page('A')?.attachments).toEqual([]);
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
    expect((await t.byPath('a.md'))?.status).toBe('ok');
  });

  it('bytes that are not the type they claim, an image over the files limit, and an empty body are refused after the fetch: nothing is stored, the link stays', async () => {
    const t = await setup([md('a.md\u0000![x](https://i.example/a.png) ![y](https://i.example/b.png) ![z](https://i.example/c.png)\n')], {
      fetcher: new ScriptedFetcher((url) => (url.endsWith('a.png') ? ok(Buffer.from('not a png at all'), 'image/png') : url.endsWith('b.png') ? ok(Buffer.concat([PNG, Buffer.alloc(5000)])) : ok(Buffer.alloc(0)))),
      filesMaxBytes: 1000,
    });
    const result = await t.run();
    expect(t.page('a')?.attachments).toEqual([]);
    expect(t.page('a')?.content.markdown).toBe('![x](https://i.example/a.png) ![y](https://i.example/b.png) ![z](https://i.example/c.png)\n');
    expect((await t.files.list('tenants/')).items).toEqual([]);
    expect(result.kind === 'done' && result.counts.warnings).toBe(3);
  });

  it('an http URL is not fetched and is a warning (remote_image_scheme)', async () => {
    const fetcher = new ScriptedFetcher();
    const t = await setup([md('a.md\u0000![x](http://img.example/a.png)\n')], { fetcher });
    const result = await t.run();
    expect(fetcher.calls).toEqual([]);
    expect(t.page('a')?.content.markdown).toBe('![x](http://img.example/a.png)\n');
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });

  it('with no fetcher (fetching switched off) the link is left and counted as a warning, and nothing is asked of the network', async () => {
    const t = await setup([md('a.md\u0000![x](https://img.example/a.png)\n')], { fetcher: undefined });
    const result = await t.run();
    expect(t.page('a')?.content.markdown).toBe('![x](https://img.example/a.png)\n');
    expect(result.kind === 'done' && result.counts.warnings).toBe(1);
  });

  it('without the remote dependency at all, remote images are not looked at (no warnings)', async () => {
    const t = await setup([md('a.md\u0000![x](https://img.example/a.png)\n')], { remote: false });
    const result = await t.run();
    expect(result.kind === 'done' && result.counts.warnings).toBe(0);
  });

  it('the objects copied for a page that is not written are removed', async () => {
    const t = await setup([md('a.md\u0000# Bad\n![x](https://img.example/a.png)\n')], { fetcher: new ScriptedFetcher() });
    t.converter.fail = (m) => m.startsWith('# Bad');
    await t.run();
    expect((await t.files.list('tenants/')).items.filter((i) => i.key.includes('/attachments/'))).toEqual([]);
  });
});

describe('the budget', () => {
  it('is one for the import: images beyond it stay links (budget), and the count of copies is kept in the import so a resumed run goes on from it', async () => {
    const fetcher = new ScriptedFetcher();
    const t = await setup(['a', 'b', 'c'].map((n) => md(`${n}.md\u0000# ${n}\n![x](https://img.example/${n}.png)\n`)), { fetcher, maxImages: 2 });
    const controller = new AbortController();
    const real = fetcher.fetch.bind(fetcher);
    fetcher.fetch = async (url, budget) => { const r = await real(url, budget); if (budget.taken === 2) controller.abort(); return r; };
    const first = await t.run({ batchPages: 2, signal: controller.signal });
    expect(first).toMatchObject({ kind: 'stopped', reason: 'aborted', counts: { remote: 2 } });
    expect((await t.repo.get(TENANT, 'imp'))?.counts.remote).toBe(2);
    const second = await t.run();
    expect(second.kind).toBe('done');
    expect(t.page('c')?.attachments).toEqual([]); // the third image met the budget of the first run: 2 of 2 taken
    expect(t.page('c')?.content.markdown).toContain('https://img.example/c.png');
    expect(second.kind === 'done' && second.counts.remote).toBe(2);
  });
});
