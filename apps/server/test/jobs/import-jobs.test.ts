import { describe, expect, it } from 'vitest';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import type { ImportRepo, ImportStatus } from '@tektum/grimoire-core/ports/import-repo';
import { abandonStaleImports, IMPORT_ABANDON_MS } from '../../src/jobs/import-abandon.js';
import { runImportCleanup } from '../../src/jobs/import-cleanup.js';
import { runImportSweep } from '../../src/jobs/import-sweep.js';
import { registerJobs } from '../../src/jobs/index.js';
import { importSingletonKey } from '../../src/jobs/types.js';
import { fakeJobDeps } from './deps.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const live = new AbortController().signal;

function world(tenants: readonly string[] = ['T-a', 'T-b']) {
  const imports = new FakeImportRepo();
  const liveJobs = new Set<string>();
  const started: { payload: unknown; key: string }[] = [];
  const cleaned: unknown[] = [];
  const deleted: string[][] = [];
  const aborted: [string, string][] = [];
  const row = (id: string, tenantId: string, status: ImportStatus, ageHours = 0, s3Key: string | null = `tenants/${tenantId}/imports/${id}/source.zip`) =>
    imports.seed({ id, tenantId, status, s3Key }, NOW - ageHours * HOUR);
  return {
    imports,
    liveJobs,
    started,
    cleaned,
    deleted,
    aborted,
    row,
    tenants: new FakeTenantRepo([...tenants]),
    isLive: (key: string) => Promise.resolve(liveJobs.has(key)),
    enqueueImport: (payload: unknown, key: string) => {
      started.push({ payload, key });
      return Promise.resolve('job');
    },
    enqueueCleanup: (payload: unknown) => {
      cleaned.push(payload);
      return Promise.resolve('job');
    },
    deleteFiles: (keys: readonly string[]) => {
      deleted.push([...keys]);
      return Promise.resolve();
    },
    abortUpload: (key: string, uploadId: string) => {
      aborted.push([key, uploadId]);
      return Promise.resolve();
    },
    zipPresent: (key: string) => Promise.resolve(!deleted.some((keys) => keys.includes(key))),
    now: () => NOW,
  };
}

describe('the singleton key of an import job', () => {
  it('is one form: import: and the id', () => {
    expect(importSingletonKey('abc')).toBe('import:abc');
  });
});

describe('abandonStaleImports', () => {
  it('fails the uploads that stayed created or uploaded for more than 24 hours, enqueues their cleanup, and leaves the rest', async () => {
    const w = world();
    w.row('old-created', 'T-a', 'created', 25);
    w.row('old-uploaded', 'T-a', 'uploaded', 30);
    w.row('young', 'T-a', 'uploaded', 23);
    w.row('running-old', 'T-a', 'running', 99);
    w.row('done-old', 'T-a', 'done', 99);
    expect(IMPORT_ABANDON_MS).toBe(24 * HOUR);
    expect(await abandonStaleImports(w, 'T-a', live)).toBe(2);
    expect((await w.imports.get('T-a', 'old-created'))?.status).toBe('failed');
    expect((await w.imports.get('T-a', 'old-uploaded'))?.error).toBe('abandoned');
    expect((await w.imports.get('T-a', 'young'))?.status).toBe('uploaded');
    expect((await w.imports.get('T-a', 'running-old'))?.status).toBe('running');
    expect(w.cleaned).toEqual(
      expect.arrayContaining([
        { tenantId: 'T-a', importId: 'old-created' },
        { tenantId: 'T-a', importId: 'old-uploaded' },
      ]),
    );
    expect(w.cleaned).toHaveLength(2);
    expect(await abandonStaleImports(w, 'T-a', live)).toBe(0); // a second run finds nothing, and enqueues nothing more
    expect(w.cleaned).toHaveLength(2);
  });

  it('takes more than one batch', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) w.row(`i${String(i)}`, 'T-a', 'created', 30 + i);
    expect(await abandonStaleImports({ ...w, batch: 2 }, 'T-a', live)).toBe(5);
  });
});

describe('runImportSweep', () => {
  it('enqueues again the running import that has no live job, under the one key, and not the one that has', async () => {
    const w = world();
    w.row('dead', 'T-a', 'running');
    w.row('alive', 'T-b', 'running');
    w.liveJobs.add(importSingletonKey('alive'));
    expect(await runImportSweep(w, live)).toEqual({ requeued: 1, abandoned: 0 });
    expect(w.started).toEqual([{ payload: { tenantId: 'T-a', importId: 'dead' }, key: importSingletonKey('dead') }]);
  });

  it('also abandons stale uploads of every tenant, and does not look at one that is not running', async () => {
    const w = world();
    w.row('u', 'T-a', 'uploaded', 26);
    w.row('c', 'T-b', 'created', 40);
    w.row('d', 'T-b', 'done', 40);
    expect(await runImportSweep(w, live)).toEqual({ requeued: 0, abandoned: 2 });
    expect(w.started).toEqual([]);
  });

  it('leaves an upload that waits for its turn with a live job alone while it is young, and abandons it by age even though its job is live (a tenant that is busy for ever ends)', async () => {
    const w = world();
    w.row('young', 'T-a', 'uploaded', 2);
    w.row('old', 'T-b', 'uploaded', 25);
    w.liveJobs.add(importSingletonKey('young'));
    w.liveJobs.add(importSingletonKey('old'));
    expect(await runImportSweep(w, live)).toEqual({ requeued: 0, abandoned: 1 });
    expect((await w.imports.get('T-a', 'young'))?.status).toBe('uploaded');
    expect(await w.imports.get('T-b', 'old')).toMatchObject({ status: 'failed', error: 'abandoned' });
    expect(w.started).toEqual([]); // nothing is enqueued for an upload: its own job comes back on its own (it is not `running`)
    expect(w.cleaned).toEqual([{ tenantId: 'T-b', importId: 'old' }]);
  });

  it('goes on with the other tenants when one fails, and then fails', async () => {
    const w = world();
    w.row('a', 'T-a', 'running');
    w.row('b', 'T-b', 'running');
    const failing = { ...w, enqueueImport: (payload: unknown, key: string) => (JSON.stringify(payload).includes('T-a') ? Promise.reject(new Error('queue down')) : w.enqueueImport(payload, key)) };
    await expect(runImportSweep(failing, live)).rejects.toThrow('queue down');
    expect(w.started.map((s) => s.key)).toEqual([importSingletonKey('b')]);
  });
});

describe('runImportCleanup', () => {
  const payload = (importId: string, tenantId = 'T-a') => ({ importId, tenantId });

  it.each(['cancelled', 'failed'] as const)('moves the pages of a %s import to the trash and deletes its zip', async (status) => {
    const w = world();
    w.row('i', 'T-a', 'running');
    await w.imports.addItems('T-a', 'i', [{ path: 'a.md', kind: 'page' }]);
    const [item] = await w.imports.pending('T-a', 'i', 'page', 5);
    await (w.imports as ImportRepo).writePage(
      'T-a',
      'i',
      {
        itemId: item!.id,
        collectionId: 'c',
        parentId: null,
        position: () => 'a',
        title: 'T',
        createdBy: 'u',
        content: { state: new Uint8Array([1]), markdown: 'x', text: 'x', hash: Buffer.alloc(32) },
        markdownBytes: 1,
        stateBytes: 1,
        attachments: [],
      },
      { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 },
      NOW,
    );
    w.imports.setStatus('i', status);
    expect(await runImportCleanup(w, payload('i'))).toEqual({ pages: 1, zip: true });
    expect(w.deleted).toEqual([['tenants/T-a/imports/i/source.zip']]);
    expect(await runImportCleanup(w, payload('i'))).toEqual({ pages: 0, zip: true }); // idempotent: nothing left to move; deleting a key that is gone is not an error
  });

  it('aborts the multipart upload still open on a part and deletes the key of every part, so that an upload that was given up leaves nothing in the store', async () => {
    const w = world();
    w.row('m', 'T-a', 'created');
    await w.imports.addPart('T-a', 'm', { ordinal: 1, s3Key: 'tenants/T-a/imports/m/source-1.zip', bytes: 20, uploadId: 'up-1' });
    await w.imports.addPart('T-a', 'm', { ordinal: 2, s3Key: 'tenants/T-a/imports/m/source-2.zip', bytes: 20, uploadId: null });
    w.imports.setStatus('m', 'failed');
    expect(await runImportCleanup(w, payload('m'))).toEqual({ pages: 0, zip: true });
    expect(w.aborted).toEqual([['tenants/T-a/imports/m/source-1.zip', 'up-1']]);
    expect(w.deleted).toEqual([['tenants/T-a/imports/m/source.zip', 'tenants/T-a/imports/m/source-1.zip', 'tenants/T-a/imports/m/source-2.zip']]);
  });

  it('moves the pages to the trash once: a second cleanup finds the zip gone, so pages a person restored since do not go back', async () => {
    const w = world();
    w.row('i', 'T-a', 'failed');
    let trashed = 0;
    const trash = w.imports.trashImported.bind(w.imports);
    w.imports.trashImported = (...args: Parameters<typeof trash>) => { trashed += 1; return trash(...args); };
    await runImportCleanup(w, payload('i'));
    await runImportCleanup(w, payload('i'));
    expect(trashed).toBe(1);
    expect(w.deleted).toEqual([['tenants/T-a/imports/i/source.zip'], ['tenants/T-a/imports/i/source.zip']]);
  });

  it('does not trash when the store cannot say whether the zip is there: the job fails and runs again', async () => {
    const w = world();
    w.row('i', 'T-a', 'failed');
    let trashed = 0;
    const trash = w.imports.trashImported.bind(w.imports);
    w.imports.trashImported = (...args: Parameters<typeof trash>) => { trashed += 1; return trash(...args); };
    await expect(runImportCleanup({ ...w, zipPresent: () => Promise.reject(new Error('store down')) }, payload('i'))).rejects.toThrow('store down');
    expect(trashed).toBe(0);
  });

  it('keeps the pages of a done import and deletes its zip', async () => {
    const w = world();
    w.row('i', 'T-a', 'done');
    expect(await runImportCleanup(w, payload('i'))).toEqual({ pages: 0, zip: true });
    expect(w.deleted).toEqual([['tenants/T-a/imports/i/source.zip']]);
  });

  it.each(['created', 'uploaded', 'running'] as const)('does nothing for an import that is %s (it is not over)', async (status) => {
    const w = world();
    w.row('i', 'T-a', status);
    expect(await runImportCleanup(w, payload('i'))).toBeUndefined();
    expect(w.deleted).toEqual([]);
  });

  it('does nothing for an import of another tenant or one that is gone, and for one without a zip key it only trashes', async () => {
    const w = world();
    w.row('i', 'T-b', 'failed');
    expect(await runImportCleanup(w, payload('i', 'T-a'))).toBeUndefined();
    expect(await runImportCleanup(w, payload('missing'))).toBeUndefined();
    w.row('nokey', 'T-a', 'failed', 0, null);
    expect(await runImportCleanup(w, payload('nokey'))).toEqual({ pages: 0, zip: false });
    expect(w.deleted).toEqual([]);
  });
});

describe('the registry handlers of the import jobs', () => {
  const ctx = { jobId: 'j', attempt: 1, retryLimit: 1, signal: new AbortController().signal };
  const IMPORT = '11111111-1111-4111-8111-111111111111';
  const find = (jobs: ReturnType<typeof registerJobs>, name: string) => jobs.find((j) => j.name === name)!.handler;

  function setup() {
    const imports = new FakeImportRepo();
    const calls: string[] = [];
    const queue = {
      isLive: (_name: string, key: string) => {
        calls.push(`live ${key}`);
        return Promise.resolve(false);
      },
      enqueueImport: (payload: { importId: string }, options?: { singletonKey?: string }) => {
        calls.push(`import ${payload.importId} ${options?.singletonKey ?? ''}`);
        return Promise.resolve('j');
      },
      enqueueImportCleanup: (payload: { importId: string }) => {
        calls.push(`cleanup ${payload.importId}`);
        return Promise.resolve('j');
      },
      enqueueEmbedPage: () => Promise.resolve('j'),
      enqueueEmbedSweep: () => Promise.resolve('j'),
    };
    const w = fakeJobDeps({ imports, queue });
    return { ...w, imports, calls, jobs: registerJobs(w.deps) };
  }

  it('the sweep asks the queue about each running import, enqueues the one with no job under the one key, and logs it', async () => {
    const s = setup();
    s.imports.seed({ id: IMPORT, tenantId: 'T-a', status: 'running' });
    await find(s.jobs, 'import-sweep')({}, ctx);
    expect(s.calls).toEqual([`live import:${IMPORT}`, `import ${IMPORT} import:${IMPORT}`]);
    expect(s.logger.entries.map((e) => [e.event, e.fields])).toEqual([['import.swept', { importId: IMPORT, action: 'requeued' }]]);
  });

  it('the cleanup trashes and deletes the zip of an import that is over, logs it, and ignores a payload that is not an import', async () => {
    const s = setup();
    s.imports.seed({ id: IMPORT, tenantId: 'T-a', status: 'cancelled', s3Key: 'tenants/T-a/imports/x/source.zip' });
    await find(s.jobs, 'import-cleanup')({ nonsense: true }, ctx);
    expect(s.logger.entries).toEqual([]);
    await find(s.jobs, 'import-cleanup')({ tenantId: 'T-a', importId: IMPORT }, ctx);
    expect(s.logger.entries.map((e) => [e.event, e.fields])).toEqual([['import.cleaned', { importId: IMPORT, pages: 0, zip: true }]]);
  });

  it('the upload cleanup also fails the uploads that were never finished, and hands each to the cleanup', async () => {
    const s = setup();
    s.imports.seed({ id: IMPORT, tenantId: 'T-a', status: 'uploaded' }, s.clock.now() - 25 * HOUR);
    await find(s.jobs, 'upload-cleanup')({}, ctx);
    expect(s.calls).toEqual([`cleanup ${IMPORT}`]);
    expect((await s.imports.get('T-a', IMPORT))?.error).toBe('abandoned');
    expect(s.logger.entries.map((e) => e.event)).toContain('import.swept');
  });
});
