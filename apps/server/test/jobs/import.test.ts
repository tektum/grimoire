import { describe, expect, it, vi } from 'vitest';
import { ImportBusyError } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportStatus } from '@tektum/grimoire-core/ports/import-repo';
import type { EnqueueOptions, JobContext } from '@tektum/grimoire-core/ports/job-queue';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { importZipKey } from '../../src/import/keys.js';
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
  /** A conversion that takes this long (it yields to the event loop while it waits, as real I/O does). */
  takes = 0;
  async seed(markdown: string): Promise<SeedResult> {
    this.seeds++;
    for (const until = Date.now() + this.takes; Date.now() < until; ) await new Promise<void>((resolve) => { setImmediate(resolve); });
    return this.seedHook?.(markdown) ?? { ok: true, state: text(markdown.length === 0 ? ' ' : markdown) };
  }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> { const markdown = new TextDecoder().decode(state).replace(/^ $/, ''); return Promise.resolve({ ok: true, markdown, text: markdown }); }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

const ctx = (over: Partial<JobContext> = {}): JobContext => ({ jobId: 'job-1', attempt: 1, retryLimit: 3, signal: new AbortController().signal, ...over });

async function setup(entries: readonly BuilderEntry[] | Buffer | undefined, over: { status?: ImportStatus; repo?: FakeImportRepo; chunkMs?: number; batchPages?: number; maxPages?: number } = {}) {
  const repo = over.repo ?? new FakeImportRepo();
  repo.seed({ id: IMPORT, tenantId: TENANT, status: over.status ?? 'uploaded', createdBy: 'user-1', targetCollectionId: 'col', s3Key: importZipKey(TENANT, IMPORT) });
  const files = new FakeFileStorage();
  const zip = entries === undefined ? undefined : Buffer.isBuffer(entries) ? entries : buildZip(entries as BuilderEntry[]);
  if (zip !== undefined) await files.put(importZipKey(TENANT, IMPORT), zip, { size: zip.length, contentType: 'application/zip' });
  const converter = new EchoConverter();
  const enqueued: { name: string; payload: unknown; options: EnqueueOptions | undefined }[] = [];
  const logger = new FakeLogger();
  const handler = createImportHandler({
    config: makeFakeConfig(), log: createEventLog(logger), clock: { now: () => 1_700_000_000_000 }, imports: repo, files, converter, ordering: { between: (b: string | null) => `${b ?? ''}a` },
    fetcher: undefined, sniff: () => Promise.resolve(undefined), queue: {
      enqueueImport: (payload, options) => { enqueued.push({ name: 'import', payload, options }); return Promise.resolve('id'); },
      enqueueImportCleanup: (payload) => { enqueued.push({ name: 'import-cleanup', payload, options: undefined }); return Promise.resolve('id'); },
    },
    ...(over.chunkMs === undefined ? {} : { chunkMs: over.chunkMs }), ...(over.batchPages === undefined ? {} : { batchPages: over.batchPages }), ...(over.maxPages === undefined ? {} : { maxPages: over.maxPages }),
  });
  const run = (context: JobContext = ctx(), payload: unknown = { tenantId: TENANT, importId: IMPORT }) => handler(payload, context);
  const record = () => repo.get(TENANT, IMPORT);
  const items = () => repo.scanItems(TENANT, IMPORT, { limit: 1000 });
  return { repo, files, converter, enqueued, logger, run, record, items };
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

  it('a running import (a duplicate delivery, or a resume) goes on from its pending items and writes no page twice', async () => {
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n')], { status: 'running' });
    await t.run();
    const written = t.repo.written.length;
    t.repo.setStatus(IMPORT, 'running'); // as if the end had not been recorded
    await t.run();
    expect(t.repo.written).toHaveLength(written);
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
    const t = await setup([md('a.md\u0000# A\n'), md('b.md\u0000# B\n'), md('c.md\u0000# C\n')], { chunkMs: 1, batchPages: 1 });
    t.converter.takes = 15;
    let runs = 0;
    while ((await t.record())?.status !== 'done' && runs < 10) { await t.run(); runs++; }
    expect(await t.record()).toMatchObject({ status: 'done', counts: { pagesDone: 3 } });
    expect(runs).toBe(3);
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
