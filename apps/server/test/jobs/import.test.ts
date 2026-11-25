import { describe, expect, it, vi } from 'vitest';
import { ImportBusyError } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportSource, ImportStatus } from '@tektum/grimoire-core/ports/import-repo';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import type { EnqueueOptions, JobContext } from '@tektum/grimoire-core/ports/job-queue';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { importFailedKey, importZipKey } from '../../src/import/keys.js';
import { createImportHandler } from '../../src/jobs/import.js';
import { buildZip } from '../import/hostile/zip-builder.js';
import type { BuilderEntry } from '../import/hostile/zip-builder.js';

// The `import` job (M7 contracts section 4): stage 2 (the archive), pass one, pass two in chunks of its own continuation, and the endings.
const TENANT = 'tenant-1';
const IMPORT = '11111111-1111-4111-8111-111111111111';
const text = (s: string) => new TextEncoder().encode(s);
const md = (s: string) => ({ name: s.split('\u0000')[0] as string, data: Buffer.from(s.split('\u0000')[1] ?? '') });

class EchoConverter implements MarkdownConverter {
  seeds = 0;
  seedHook: ((markdown: string) => SeedResult | undefined) | undefined;
  async seed(markdown: string): Promise<SeedResult> {
    this.seeds++;
    return this.seedHook?.(markdown) ?? { ok: true, state: text(markdown.length === 0 ? ' ' : markdown) };
  }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> { const markdown = new TextDecoder().decode(state).replace(/^ $/, ''); return Promise.resolve({ ok: true, markdown, text: markdown }); }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

/** A file store's settings, so that a page's files become its attachments (without one an import keeps the links and stores nothing). */
const FILES_CONFIG: FilesConfig = { endpoint: 'http://store.test', publicEndpoint: 'http://store.test', publicOrigin: 'http://store.test', bucket: 'b', region: 'r', addressing: 'path', createOnlyHeader: 'if-none-match', corsMode: 'api', maxBytes: 26_214_400, allowedTypes: ['text/csv', 'image/png'], pendingMaxPerUser: 20 };

const ctx = (over: Partial<JobContext> = {}): JobContext => ({ jobId: 'job-1', attempt: 1, retryLimit: 3, signal: new AbortController().signal, ...over });

async function setup(entries: readonly BuilderEntry[] | Buffer | undefined, over: { status?: ImportStatus; source?: ImportSource; files?: boolean; repo?: FakeImportRepo; chunkSignal?: (ms: number) => AbortSignal; batchPages?: number; maxPages?: number } = {}) {
  const repo = over.repo ?? new FakeImportRepo();
  repo.seed({ id: IMPORT, tenantId: TENANT, status: over.status ?? 'uploaded', createdBy: 'user-1', targetCollectionId: 'col', s3Key: importZipKey(TENANT, IMPORT), ...(over.source === undefined ? {} : { source: over.source }) });
  const files = new FakeFileStorage();
  const zip = entries === undefined ? undefined : Buffer.isBuffer(entries) ? entries : buildZip(entries as BuilderEntry[]);
  if (zip !== undefined) await files.put(importZipKey(TENANT, IMPORT), zip, { size: zip.length, contentType: 'application/zip' });
  const converter = new EchoConverter();
  const enqueued: { name: string; payload: unknown; options: EnqueueOptions | undefined }[] = [];
  const logger = new FakeLogger();
  const handle: { queueOverride?: (() => Promise<string | null>) | undefined } = {};
  const handler = createImportHandler({
    config: makeFakeConfig(over.files === true ? { files: FILES_CONFIG } : {}), log: createEventLog(logger), clock: { now: () => 1_700_000_000_000 }, imports: repo, files, converter, ordering: { between: (b: string | null) => `${b ?? ''}a` },
    fetcher: undefined, sniff: () => Promise.resolve(undefined), queue: {
      enqueueImport: (payload, options) => { enqueued.push({ name: 'import', payload, options }); return handle.queueOverride?.() ?? Promise.resolve('id'); },
      enqueueImportCleanup: (payload) => { enqueued.push({ name: 'import-cleanup', payload, options: undefined }); return Promise.resolve('id'); },
    },
    ...(over.chunkSignal === undefined ? {} : { chunkSignal: over.chunkSignal }), ...(over.batchPages === undefined ? {} : { batchPages: over.batchPages }), ...(over.maxPages === undefined ? {} : { maxPages: over.maxPages }),
  });
  const run = (context: JobContext = ctx(), payload: unknown = { tenantId: TENANT, importId: IMPORT }) => handler(payload, context);
  const record = () => repo.get(TENANT, IMPORT);
  const items = () => repo.scanItems(TENANT, IMPORT, { limit: 1000 });
  return { repo, files, converter, enqueued, logger, run, record, items, set queueOverride(f: (() => Promise<string | null>) | undefined) { handle.queueOverride = f; } };
}

const cleanup = (t: { enqueued: { name: string; payload: unknown }[] }) => t.enqueued.filter((e) => e.name === 'import-cleanup');

describe('a job that has nothing to do', () => {
  it.each([['cancelled'], ['created']] as const)('an import that is %s: it returns, touches nothing, retries nothing', async (status) => {
    const t = await setup([md('a.md\u0000# A\n')], { status });
    const get = vi.spyOn(t.files, 'get');
    await expect(t.run()).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(t.converter.seeds).toBe(0);
    expect(t.enqueued).toEqual([]);
    expect((await t.record())?.status).toBe(status);
  });

  it.each([['done'], ['failed']] as const)('an import that is already %s: nothing is run, but the clean-up is asked for again (a retry after the end was recorded and the first ask was lost)', async (status) => {
    const t = await setup([md('a.md\u0000# A\n')], { status });
    const get = vi.spyOn(t.files, 'get');
    await expect(t.run()).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(t.converter.seeds).toBe(0);
    expect(t.enqueued).toEqual([{ name: 'import-cleanup', payload: { importId: IMPORT, tenantId: TENANT }, options: undefined }]);
    expect((await t.record())?.status).toBe(status);
  });

  it('an import that does not exist, or belongs to another tenant, is the same', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    await expect(t.run(ctx(), { tenantId: 'someone-else', importId: IMPORT })).resolves.toBeUndefined();
    await expect(t.run(ctx(), { tenantId: TENANT, importId: '22222222-2222-4222-8222-222222222222' })).resolves.toBeUndefined();
    expect((await t.record())?.status).toBe('uploaded');
  });

  it('a payload that is not exactly {tenantId, importId} is dropped, not an error', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    for (const payload of [null, 'x', 42, { importId: IMPORT }, { tenantId: TENANT, importId: IMPORT, extra: 1 }, { tenantId: '../x', importId: IMPORT }, { tenantId: TENANT, importId: 'not-a-uuid' }]) await expect(t.run(ctx(), payload)).resolves.toBeUndefined();
    expect((await t.record())?.status).toBe('uploaded');
  });

  it('a tenant that already has a running import: the job does not fail and spends no retry; it enqueues its own continuation 30 s later under the import\'s key, and the import is not touched', async () => {
    const repo = new FakeImportRepo();
    const t = await setup([md('a.md\u0000# A\n')], { repo });
    repo.start = () => Promise.reject(new ImportBusyError());
    await expect(t.run(ctx({ attempt: 4, retryLimit: 3 }))).resolves.toBeUndefined(); // even on the last attempt: nothing is thrown, so nothing reaches the dead-letter queue
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: IMPORT, tenantId: TENANT }, options: { singletonKey: `import:${IMPORT}`, delaySeconds: 30 } }]);
    const record = await t.record();
    expect(record?.status).toBe('uploaded');
    expect(record?.error).toBeNull();
  });
});

describe('an import that runs to its end', () => {
  it('imports the pages, ends done with its counts, and asks for the clean-up', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('dir/b.md\u0000# B\n')]);
    await t.run();
    const record = await t.record();
    expect(record).toMatchObject({ status: 'done', error: null, finishedAt: 1_700_000_000_000, counts: { pagesDone: 3, pagesTotal: 3 } });
    expect(t.repo.written.map((w) => w.page.title).sort()).toEqual(['A', 'B', 'dir']);
    expect(cleanup(t)).toEqual([{ name: 'import-cleanup', payload: { importId: IMPORT, tenantId: TENANT }, options: undefined }]);
  });

  it('is done also when some items failed or were skipped', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('bad.md\u0000# Bad\n')]);
    t.converter.seedHook = (m) => (m.startsWith('# Bad') ? { ok: false, reason: 'invalid-markdown', detail: 'x' } : undefined);
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 1, failed: 1 } });
  });

  it('a resume goes on from the pending items of a partly done import: the pages written before are not written again, and the rest are', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')], { batchPages: 1 });
    const controller = new AbortController();
    t.converter.seedHook = () => { controller.abort(); return undefined; };
    await t.run(ctx({ signal: controller.signal })); // the first run ends after one page: a is written, b and c are pending
    expect((await t.record())?.status).toBe('running');
    expect(t.repo.written.map((w) => w.page.title)).toEqual(['A']);
    t.converter.seedHook = undefined;
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 3, pagesTotal: 3 } });
    expect(t.repo.written.map((w) => w.page.title)).toEqual(['A', 'B', 'C']); // A once
  });

  it('two deliveries of one import at the same time (items in flight in both) write each page once and both end without an error', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')], { batchPages: 1 });
    await Promise.all([t.run(), t.run()]);
    expect([...t.repo.written.map((w) => w.page.title)].sort()).toEqual(['A', 'B', 'C']);
    expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 3 } });
  });
});

describe('the profile an import is read with is the one of its source', () => {
  const ID1 = '0123456789abcdef0123456789abcdef';
  const ID2 = 'fedcba9876543210fedcba9876543210';
  // A page of a Notion export, its file name with an id and a different first heading, and a page in the folder of the same name beside it.
  const exported = [md(`Plan ${ID1}.md\u0000# Another heading\n\nbody\n`), md(`Plan ${ID1}/Step ${ID2}.md\u0000# Step heading\n`)];
  const pages = async (t: Awaited<ReturnType<typeof setup>>) => {
    const byTitle = new Map<string, { pageId: string | null; parentId: string | null }>();
    for (const w of t.repo.written) byTitle.set(w.page.title, { pageId: (await t.repo.getItem(TENANT, IMPORT, w.page.itemId))?.pageId ?? null, parentId: w.page.parentId });
    return byTitle;
  };

  it('an export of Notion (notion_md_csv): the title is the # heading on the first line (Q1), and the pages of the folder beside a page are its children, with no empty page for the folder', async () => {
    const t = await setup(exported, { source: 'notion_md_csv' });
    await t.run();
    expect(t.repo.written).toHaveLength(2); // no empty page for the folder (its title would read Plan)
    const byTitle = await pages(t);
    expect([...byTitle.keys()].sort()).toEqual(['Another heading', 'Step heading']);
    expect(byTitle.get('Step heading')?.parentId).toBe(byTitle.get('Another heading')?.pageId);
    expect(byTitle.get('Another heading')?.parentId).toBeNull();
  });

  it('an export of Notion whose folder beside a page has the name without the id (X/ beside X <id>.md): the folder\'s pages are the page\'s children, no empty page', async () => {
    const t = await setup([md(`Plan ${ID1}.md\u0000# Plan\n`), md(`Plan/Step ${ID2}.md\u0000# Step\n`)], { source: 'notion_md_csv' });
    await t.run();
    expect(t.repo.written.map((w) => w.page.title).sort()).toEqual(['Plan', 'Step']); // no empty page for the folder
    const plan = (await t.items()).find((i) => i.path === `Plan ${ID1}.md`);
    expect(t.repo.written.find((w) => w.page.title === 'Step')?.page.parentId).toBe(plan?.pageId);
  });

  it('an export of Notion with Plan.md (no id) and Plan <id>.md beside the folder Plan/: Plan.md owns it, as in any zip, whatever the order of the entries', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const pages = [md(`Plan.md\u0000# Plan\n`), md(`Plan ${ID1}.md\u0000# Plan\n`)];
      const t = await setup([...order.map((i) => pages[i]!), md(`Plan/Step ${ID2}.md\u0000# Step\n`)], { source: 'notion_md_csv' });
      await t.run();
      const plain = (await t.items()).find((i) => i.path === 'Plan.md');
      expect(t.repo.written.find((w) => w.page.title === 'Step')?.page.parentId).toBe(plain?.pageId);
      expect(t.repo.written).toHaveLength(3); // no empty page for the folder
    }
  });

  it('an export of Notion whose one page beside the folder has its id in capitals: the name is matched without case, id included, as its rivals are counted, so it owns the folder', async () => {
    const UPPER = ID1.toUpperCase();
    const t = await setup([md(`Plan ${UPPER}.md\u0000# Plan\n`), md(`Plan/Step ${ID2}.md\u0000# Step\n`)], { source: 'notion_md_csv' });
    await t.run();
    const plan = (await t.items()).find((i) => i.path === `Plan ${UPPER}.md`);
    expect(t.repo.written.find((w) => w.page.title === 'Step')?.page.parentId).toBe(plan?.pageId);
    expect(t.repo.written).toHaveLength(2); // no empty page for the folder
  });

  it('an export of Notion with two pages of one name beside one folder of that name: the folder stays an empty page of its own (which page owns it is not known)', async () => {
    const ID3 = '00112233445566778899aabbccddeeff';
    const t = await setup([md(`Plan ${ID1}.md\u0000# Plan\n`), md(`Plan ${ID3}.md\u0000# Plan\n`), md(`Plan/Step ${ID2}.md\u0000# Step\n`)], { source: 'notion_md_csv' });
    await t.run();
    expect(t.repo.written.map((w) => w.page.title).sort()).toEqual(['Plan', 'Plan', 'Plan', 'Step']); // two pages and the folder's empty page
  });

  it('an export of Notion: a link to a database by its plain CSV name finds the _all.csv the export holds, and a link to a moved page finds it by its id', async () => {
    const ID3 = '00112233445566778899aabbccddeeff';
    const t = await setup([
      md(`Home ${ID1}.md\u0000# Home\n\n[tasks](Tasks%20${ID2}.csv) and [note](Old%20Place/Note%20${ID3}.md)\n`),
      { name: `Tasks ${ID2}_all.csv`, data: Buffer.from('Name,Done\nOne,Yes\n') },
      md(`New Place/Note ${ID3}.md\u0000# Note\n`),
    ], { source: 'notion_md_csv', files: true });
    await t.run();
    const home = (await t.items()).find((i) => i.path === `Home ${ID1}.md`);
    expect(home).toMatchObject({ status: 'ok', warnings: 0 }); // both links found
    const body = t.repo.written.find((w) => w.page.title === 'Home')?.page.content.markdown ?? '';
    expect(body).not.toContain('Old%20Place');
    expect(body).not.toContain(`Tasks%20${ID2}.csv`);
  });

  it('an export of Notion: a callout is stored as a quote with a bold first line, and a plain Markdown zip keeps it as it was written', async () => {
    const page = md(`Tip ${ID1}.md\u0000# Tip\n\n<aside>\n💡 Keep the receipts\n\n</aside>\n`);
    const notion = await setup([page], { source: 'notion_md_csv' });
    await notion.run();
    expect(notion.repo.written[0]?.page.content.markdown).toContain('> **💡 Keep the receipts**');
    const plain = await setup([page]);
    await plain.run();
    expect(plain.repo.written[0]?.page.content.markdown).toContain('<aside>');
  });

  it('an export of Notion: the # heading on the first line is the title and is not repeated in the body; a plain Markdown zip keeps its first line', async () => {
    const page = md(`Plan for the ${ID1}.md\u0000# Plan for the year\n\nBody text\n`);
    const notion = await setup([page], { source: 'notion_md_csv' });
    await notion.run();
    expect(notion.repo.written[0]?.page.title).toBe('Plan for the year');
    expect(notion.repo.written[0]?.page.content.markdown).not.toContain('# Plan for the year');
    expect(notion.repo.written[0]?.page.content.markdown).toContain('Body text');
    const plain = await setup([page]);
    await plain.run();
    expect(plain.repo.written[0]?.page.content.markdown).toContain('# Plan for the year');
  });

  it('an export of Notion: a first line that is not the title heading is kept, and so is a heading longer than a title may be (the title is cut, the line keeps all of it)', async () => {
    const long = `# ${'Long '.repeat(60)}end\n\nBody\n`;
    const t = await setup([md(`Plan ${ID1}.md\u0000## Agenda\n\nBody\n`), md(`Long ${ID2}.md\u0000${long}`)], { source: 'notion_md_csv' });
    await t.run();
    const plan = t.repo.written.find((w) => w.page.title === 'Plan');
    expect(plan?.page.content.markdown).toContain('## Agenda');
    const cut = t.repo.written.find((w) => w.page.title.startsWith('Long Long'));
    expect([...(cut?.page.title ?? '')]).toHaveLength(255);
    expect(cut?.page.content.markdown).toContain('end');
  });

  it('an export of Notion: what follows the title line is never read as front matter (front matter sits at the very top of a file, and this file opens with its title)', async () => {
    const t = await setup([md(`Plan ${ID1}.md\u0000# Plan\n---\nowner: kept\n---\nBody\n`)], { source: 'notion_md_csv' });
    await t.run();
    expect(t.repo.written[0]?.page.content.markdown).toContain('owner: kept');
  });

  describe('a database of an export of Notion (decision 112: a source database is a plain table on a page)', () => {
    const csv = (name: string, text: string) => ({ name, data: Buffer.from(text) });

    it('its _all.csv becomes one page holding its table, titled with its name, and a link to it opens that page', async () => {
      const t = await setup([md(`Home ${ID1}.md\u0000# Home\n\n[tasks](Tasks%20${ID2}.csv)\n`), csv(`Tasks ${ID2}_all.csv`, 'Name,Done\nWrite,Yes\nRead,No\n')], { source: 'notion_md_csv', files: true });
      await t.run();
      const items = await t.items();
      const database = items.find((i) => i.path === `Tasks ${ID2}_all.csv`);
      expect(database).toMatchObject({ kind: 'database_csv', status: 'ok' });
      expect(t.repo.written.find((w) => w.page.title === 'Tasks')?.page.content.markdown).toBe('| Name | Done |\n| --- | --- |\n| Write | Yes |\n| Read | No |\n');
      expect(items.find((i) => i.path === `Home ${ID1}.md`)).toMatchObject({ status: 'ok', warnings: 0 });
      expect(t.repo.written.find((w) => w.page.title === 'Home')?.page.content.markdown).toContain(`/p/${database?.urlId ?? 'none'}`);
      expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesTotal: 2, pagesDone: 2 } });
    });

    it('a CSV that cannot be read, and a table over 1,000 rows, are failed database items with their reason, and the import goes on', async () => {
      const ID3 = '00112233445566778899aabbccddeeff';
      const rows = Array.from({ length: 1001 }, (_v, i) => `r${String(i)},x`).join('\n');
      const t = await setup([md(`Home ${ID1}.md\u0000# Home\n`), csv(`Broken ${ID2}_all.csv`, 'a,"b\nc,d\n'), csv(`Big ${ID3}_all.csv`, `Name,Value\n${rows}\n`)], { source: 'notion_md_csv', files: true });
      await t.run();
      const items = await t.items();
      expect(items.find((i) => i.path === `Broken ${ID2}_all.csv`)).toMatchObject({ status: 'failed', message: 'csv_malformed' });
      expect(items.find((i) => i.path === `Big ${ID3}_all.csv`)).toMatchObject({ status: 'failed', message: 'table_too_large' });
      expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 1, failed: 2 } });
    });

    it('a table whose Markdown is over the seed cap, though not over the table cap, is a failed database item table_too_large (the engine checks the cap before the converter)', async () => {
      const rows = Array.from({ length: 600 }, (_v, i) => `row ${String(i)},${'x'.repeat(240)}`).join('\n');
      const t = await setup([csv(`Wide ${ID2}_all.csv`, `Name,Value\n${rows}\n`)], { source: 'notion_md_csv', files: true });
      await t.run();
      expect((await t.items()).find((i) => i.path === `Wide ${ID2}_all.csv`)).toMatchObject({ status: 'failed', message: 'table_too_large' });
      expect(t.repo.written).toEqual([]);
    });

    describe('its row pages (decision 167)', () => {
      const R1 = '0123456789abcdef0123456789abcde1';
      const R2 = '0123456789abcdef0123456789abcde2';
      const R3 = '0123456789abcdef0123456789abcde3';
      const R4 = '0123456789abcdef0123456789abcde4';
      const R5 = '0123456789abcdef0123456789abcde5';
      const database = csv(`Tasks ${ID2}_all.csv`, 'Name,Status\nWrite plan,Done\nReview,Open\nOdd,Open\nParent,Open\n');

      it('a row page with text of its own, or a page under it, goes under the database page; one that only repeats its row is skipped database_row', async () => {
        const t = await setup([
          database,
          md(`Tasks/Write plan ${R1}.md\u0000# Write plan\n\nStatus: Done\n`),
          md(`Tasks/Review ${R2}.md\u0000# Review\n\nStatus: Open\n\nNotes from the review.\n`),
          md(`Tasks/Odd ${R3}.md\u0000# Odd\n\nNote: not a column of the table\n`),
          md(`Tasks/Parent ${R4}.md\u0000# Parent\n\nStatus: Open\n`),
          md(`Tasks/Parent/Child ${R5}.md\u0000# Child\n`),
        ], { source: 'notion_md_csv', files: true });
        await t.run();
        const items = await t.items();
        const db = items.find((i) => i.path === `Tasks ${ID2}_all.csv`);
        expect(items.find((i) => i.path === `Tasks/Write plan ${R1}.md`)).toMatchObject({ status: 'skipped', message: 'database_row' });
        for (const title of ['Review', 'Odd', 'Parent']) expect(t.repo.written.find((w) => w.page.title === title)?.page.parentId).toBe(db?.pageId);
        expect(t.repo.written.map((w) => w.page.title).sort()).toEqual(['Child', 'Odd', 'Parent', 'Review', 'Tasks']); // no empty page for the folder
      });

      it('a link to a row page that only repeats its row opens the database page, though the linking page is written before the row is dealt with', async () => {
        const t = await setup([md(`Home ${ID1}.md\u0000# Home\n\n[plan](Tasks/Write%20plan%20${R1}.md)\n`), database, md(`Tasks/Write plan ${R1}.md\u0000# Write plan\n\nStatus: Done\n`)], { source: 'notion_md_csv', files: true });
        await t.run();
        const items = await t.items();
        const db = items.find((i) => i.path === `Tasks ${ID2}_all.csv`);
        expect(t.repo.written.find((w) => w.page.title === 'Home')?.page.content.markdown).toContain(`/p/${db?.urlId ?? 'none'}`);
        expect(items.find((i) => i.path === `Home ${ID1}.md`)).toMatchObject({ status: 'ok', warnings: 0 });
      });

      it('a folder that a page and a database of one name share: a page whose title is a row of the table goes under the database, any other under the page, and no empty page is made', async () => {
        const ID3 = '00112233445566778899aabbccddeeff';
        const t = await setup([
          md(`Roadmap ${ID1}.md\u0000# Roadmap\n\nOur plans.\n`),
          csv(`Roadmap ${ID3}_all.csv`, 'Name,Status\nShip it,Open\nPolish,Done\n'),
          md(`Roadmap/Ship it ${R1}.md\u0000# Ship it\n\nStatus: Open\n\nWhat shipping takes.\n`),
          md(`Roadmap/Polish ${R2}.md\u0000# Polish\n\nStatus: Done\n`),
          md(`Roadmap/Notes ${R3}.md\u0000# Notes\n\nFrom the planning meeting.\n`),
        ], { source: 'notion_md_csv', files: true });
        await t.run();
        const items = await t.items();
        const page = items.find((i) => i.path === `Roadmap ${ID1}.md`);
        const db = items.find((i) => i.path === `Roadmap ${ID3}_all.csv`);
        expect(t.repo.written.find((w) => w.page.title === 'Ship it')?.page.parentId).toBe(db?.pageId);
        expect(t.repo.written.find((w) => w.page.title === 'Notes')?.page.parentId).toBe(page?.pageId);
        expect(items.find((i) => i.path === `Roadmap/Polish ${R2}.md`)).toMatchObject({ status: 'skipped', message: 'database_row' });
        expect(t.repo.written).toHaveLength(4); // the page, the database, Ship it, Notes: no empty page for the folder
      });

      it('a row of a database that failed is kept as a page: no table shows it', async () => {
        const rows = Array.from({ length: 1001 }, (_v, i) => `r${String(i)},Open`).join('\n');
        const t = await setup([csv(`Tasks ${ID2}_all.csv`, `Name,Status\n${rows}\n`), md(`Tasks/r1 ${R1}.md\u0000# r1\n\nStatus: Open\n`)], { source: 'notion_md_csv', files: true });
        await t.run();
        const items = await t.items();
        expect(items.find((i) => i.path === `Tasks ${ID2}_all.csv`)).toMatchObject({ status: 'failed', message: 'table_too_large' });
        expect(items.find((i) => i.path === `Tasks/r1 ${R1}.md`)).toMatchObject({ status: 'ok' });
      });

      it('a folder that a page and a database share, when the database fails: its rows go under the page, as the folder\'s other pages do', async () => {
        const ID3 = '00112233445566778899aabbccddeeff';
        const rows = Array.from({ length: 1001 }, (_v, i) => `r${String(i)},Open`).join('\n');
        const t = await setup([
          md(`Roadmap ${ID1}.md\u0000# Roadmap\n\nOur plans.\n`),
          csv(`Roadmap ${ID3}_all.csv`, `Name,Status\n${rows}\n`),
          md(`Roadmap/r1 ${R1}.md\u0000# r1\n\nStatus: Open\n`),
        ], { source: 'notion_md_csv', files: true });
        await t.run();
        const items = await t.items();
        expect(items.find((i) => i.path === `Roadmap ${ID3}_all.csv`)).toMatchObject({ status: 'failed', message: 'table_too_large' });
        expect(t.repo.written.find((w) => w.page.title === 'r1')?.page.parentId).toBe(items.find((i) => i.path === `Roadmap ${ID1}.md`)?.pageId);
      });

      it('a row is matched to its table in one Unicode form: a title with a decomposed accent is the row its table spells composed', async () => {
        const ID3 = '00112233445566778899aabbccddeeff';
        const t = await setup([
          md(`Menu ${ID1}.md\u0000# Menu\n\nWhat we serve.\n`),
          csv(`Menu ${ID3}_all.csv`, 'Name,Kind\nCaf\u00e9,Drink\n'),
          md(`Menu/Cafe\u0301 ${R1}.md\u0000# Cafe\u0301\n\nKind: Drink\n\nServed hot.\n`),
        ], { source: 'notion_md_csv', files: true });
        await t.run();
        const db = (await t.items()).find((i) => i.path === `Menu ${ID3}_all.csv`);
        expect(t.repo.written.find((w) => w.page.title.normalize('NFC') === 'Caf\u00e9')?.page.parentId).toBe(db?.pageId);
      });
    });

    it('a table of exactly 1,000 rows, and one whose Markdown is exactly the cap, are database pages: the limits are inclusive', async () => {
      const ID3 = '00112233445566778899aabbccddeeff';
      const thousand = `Name,Value\n${Array.from({ length: 1000 }, (_v, i) => `r${String(i)},x`).join('\n')}\n`;
      // The seed cap of the fake configuration is 131,072 bytes: `| Name |\n` and `| --- |\n` take 17, the one row 5 more than its cell.
      const exact = `Name\n${'x'.repeat(131_072 - 22)}\n`;
      const t = await setup([csv(`Rows ${ID2}_all.csv`, thousand), csv(`Wide ${ID3}_all.csv`, exact)], { source: 'notion_md_csv', files: true });
      await t.run();
      const items = await t.items();
      expect(items.find((i) => i.path === `Rows ${ID2}_all.csv`)).toMatchObject({ status: 'ok' });
      expect(items.find((i) => i.path === `Wide ${ID3}_all.csv`)).toMatchObject({ status: 'ok' });
      expect(Buffer.byteLength(t.repo.written.find((w) => w.page.title === 'Wide')?.page.content.markdown ?? '')).toBe(131_072);
    });

    it('a CSV over four times the table cap makes no table under it: it is table_too_large without being read as a table (even a malformed one), and its CSV is kept', async () => {
      const text = `a,"b\n${'x'.repeat(600_000)}\n`; // over 4 x 131,072 bytes, and never closes its quote
      const t = await setup([csv(`Huge ${ID2}_all.csv`, text)], { source: 'notion_md_csv', files: true });
      await t.run();
      const huge = (await t.items()).find((i) => i.path === `Huge ${ID2}_all.csv`);
      expect(huge).toMatchObject({ status: 'failed', message: 'table_too_large' });
      const stored = await t.files.get(importFailedKey(TENANT, IMPORT, huge?.id ?? 'none'));
      const chunks: Uint8Array[] = [];
      for await (const c of stored.body) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe(text);
    });

    it('a failed database item keeps its CSV for the report to offer (decision 168), as a failed page keeps its Markdown', async () => {
      const text = `Name,Value\n${Array.from({ length: 1001 }, (_v, i) => `r${String(i)},x`).join('\n')}\n`;
      const t = await setup([csv(`Big ${ID2}_all.csv`, text)], { source: 'notion_md_csv', files: true });
      await t.run();
      const big = (await t.items()).find((i) => i.path === `Big ${ID2}_all.csv`);
      expect(big).toMatchObject({ status: 'failed', message: 'table_too_large' });
      const stored = await t.files.get(importFailedKey(TENANT, IMPORT, big?.id ?? 'none'));
      const chunks: Uint8Array[] = [];
      for await (const c of stored.body) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe(text);
    });

    it('the plain CSV beside its _all.csv is not a second database: it is a file', async () => {
      const t = await setup([csv(`Tasks ${ID2}_all.csv`, 'Name\nWrite\n'), csv(`Tasks ${ID2}.csv`, 'Name\nWrite\n')], { source: 'notion_md_csv', files: true });
      await t.run();
      const items = await t.items();
      expect(items.find((i) => i.path === `Tasks ${ID2}_all.csv`)?.kind).toBe('database_csv');
      expect(items.find((i) => i.path === `Tasks ${ID2}.csv`)?.kind).toBe('attachment');
    });

    it('a plain Markdown zip keeps a CSV a file, as before', async () => {
      const t = await setup([csv(`Tasks ${ID2}_all.csv`, 'Name\nWrite\n')], { files: true });
      await t.run();
      expect((await t.items()).find((i) => i.path === `Tasks ${ID2}_all.csv`)?.kind).toBe('attachment');
    });
  });

  it('the same archive as a plain Markdown zip (markdown_zip, the default): titles from the first heading, and the folder is an empty page of its own', async () => {
    const t = await setup(exported);
    await t.run();
    expect([...(await pages(t)).keys()].sort()).toEqual(['Another heading', `Plan ${ID1}`, 'Step heading']);
  });
});

describe('an archive that cannot be imported ends the import as failed, with the reason as its error', () => {
  it('a name that would write outside the import is refused as a whole', async () => {
    const t = await setup([md('a.md\u0000# A\n'), { name: '../evil.md', data: Buffer.from('x') }]);
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'failed', error: 'unsafe_path' });
    expect(t.repo.written).toEqual([]);
    expect(cleanup(t)).toHaveLength(1);
  });

  it('a zip that holds the parts of an export, and no page: failed as nested_or_split_export, before any page, and the clean-up is asked for', async () => {
    const part = (n: number) => ({ name: `Export-p-Part-${String(n)}.zip`, data: buildZip([md(`Page ${String(n)}.md\u0000# P\n`)]) });
    const t = await setup([part(1), part(2)]);
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'failed', error: 'nested_or_split_export' });
    expect(t.repo.written).toEqual([]);
    expect(cleanup(t)).toHaveLength(1);
  });

  it('something that is not a zip, and an upload that is missing', async () => {
    const notZip = await setup(Buffer.from('this is not a zip file at all, just text that is long enough'));
    await notZip.run();
    expect(await notZip.record()).toMatchObject({ status: 'failed', error: 'not_a_zip' });
    const missing = await setup(undefined);
    await missing.run();
    expect(await missing.record()).toMatchObject({ status: 'failed', error: 'upload_missing' });
  });

  it('more pages than a collection holds: failed before any page, with the count in the import', async () => {
    const t = await setup(Array.from({ length: 4 }, (_, i) => md(`p${String(i)}.md\u0000# P${String(i)}\n`)), { maxPages: 3 });
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'failed', error: 'collection_full', counts: { pagesTotal: 4 } });
    expect(t.repo.written).toEqual([]);
    expect(cleanup(t)).toHaveLength(1);
  });
});

describe('endings that are not the end of the run', () => {
  it('the abort signal (the job is near its expiry): the import stays running and the handler enqueues its own continuation under the import\'s key, then returns', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')], { batchPages: 1 });
    const controller = new AbortController();
    t.converter.seedHook = () => { controller.abort(); return undefined; };
    await t.run(ctx({ signal: controller.signal }));
    expect((await t.record())?.status).toBe('running');
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: IMPORT, tenantId: TENANT }, options: { singletonKey: `import:${IMPORT}` } }]);
    expect(cleanup(t)).toEqual([]);
  });

  it('a chunk that has used its time does the same (at least one batch of pages is done each time), and the continuations finish the import', async () => {
    // The chunk's time is the injected signal, so the test does not depend on the wall clock: each chunk's time is up once one page has been converted.
    const asked: number[] = [];
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')], {
      batchPages: 1,
      chunkSignal: (ms) => { asked.push(ms); const expired = new AbortController(); t.converter.seedHook = () => { expired.abort(); return undefined; }; return expired.signal; },
    });
    let runs = 0;
    while ((await t.record())?.status !== 'done' && runs < 10) { await t.run(); runs++; }
    expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 3 } });
    expect(runs).toBe(3);
    expect(asked).toEqual([300_000, 300_000, 300_000]); // the budget of a chunk is the 5 minutes of the job
    expect(t.enqueued.filter((e) => e.name === 'import')).toHaveLength(2); // the last run ended the import and needed none
    expect(t.repo.written.map((w) => w.page.title).sort()).toEqual(['A', 'B', 'C']);
  });

  it('a busy converter: the continuation is delayed 30 seconds and the import stays running', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.converter.seedHook = () => ({ ok: false, reason: 'internal', detail: 'queue-full' });
    await t.run();
    expect((await t.record())?.status).toBe('running');
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: IMPORT, tenantId: TENANT }, options: { singletonKey: `import:${IMPORT}`, delaySeconds: 30 } }]);
  });

  it('a continuation the queue did not add (null) is an error, so the job is retried and never leaves a running import without a successor', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')], { batchPages: 1 });
    t.queueOverride = () => Promise.resolve(null);
    const controller = new AbortController();
    t.converter.seedHook = () => { controller.abort(); return undefined; };
    await expect(t.run(ctx({ signal: controller.signal }))).rejects.toThrow('continuation');
    const busy = await setup([md('a.md\u0000# A\n')]);
    busy.queueOverride = () => Promise.resolve(null);
    busy.repo.start = () => Promise.reject(new ImportBusyError());
    await expect(busy.run()).rejects.toThrow('continuation');
  });

  it('a chunk cut short while the process stops (the queue takes no job: jobs-unavailable) ends without failing, even on its last attempt: the import stays running for the sweep', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')], { batchPages: 1 });
    t.queueOverride = () => Promise.reject(new Error('jobs-unavailable'));
    const controller = new AbortController();
    t.converter.seedHook = () => { controller.abort(); return undefined; };
    await expect(t.run(ctx({ attempt: 4, retryLimit: 3, signal: controller.signal }))).resolves.toBeUndefined();
    expect((await t.record())?.status).toBe('running');
  });

  it('an upload that waits for its turn while the process stops keeps its job: the job fails, so the queue retries it (the sweep gives a running import a job, not a waiting one)', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.queueOverride = () => Promise.reject(new Error('jobs-unavailable'));
    t.repo.start = () => Promise.reject(new ImportBusyError());
    await expect(t.run()).rejects.toThrow('jobs-unavailable');
  });

  it('a collection that is gone ends the import as failed', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.repo.writePage = () => Promise.resolve({ kind: 'collection-deleted' });
    await t.run();
    expect(await t.record()).toMatchObject({ status: 'failed', error: 'collection_deleted' });
    expect(cleanup(t)).toHaveLength(1);
  });

  it('an import cancelled while it ran is left as it is: the handler returns, no clean-up from here', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.converter.seedHook = () => { t.repo.setStatus(IMPORT, 'cancelled'); return undefined; };
    await t.run();
    expect((await t.record())?.status).toBe('cancelled');
    expect(cleanup(t)).toEqual([]);
  });
});

describe('a failure of the job', () => {
  it('while retries remain: the error goes up for the queue to retry, the import stays running', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.converter.seedHook = () => { throw new Error('boom'); };
    await expect(t.run(ctx({ attempt: 2, retryLimit: 3 }))).rejects.toThrow('boom');
    expect((await t.record())?.status).toBe('running');
    expect(cleanup(t)).toEqual([]);
  });

  it('on the last attempt: the import ends failed with job_failed, the clean-up is asked for, and the error still goes up', async () => {
    const t = await setup([md('a.md\u0000# A\n')]);
    t.converter.seedHook = () => { throw new Error('boom'); };
    await expect(t.run(ctx({ attempt: 4, retryLimit: 3 }))).rejects.toThrow('boom');
    expect(await t.record()).toMatchObject({ status: 'failed', error: 'job_failed' });
    expect(cleanup(t)).toHaveLength(1);
  });
});


