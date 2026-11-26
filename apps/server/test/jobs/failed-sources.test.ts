import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import { importFailedKey, importZipKey } from '../../src/import/keys.js';
import { FAILED_SOURCE_RETENTION_MS, runFailedSourceCleanup } from '../../src/jobs/failed-sources.js';
import { fakeJobDeps } from './deps.js';
import { registerJobs } from '../../src/jobs/index.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const live = new AbortController().signal;

/** Objects as they were written `ageDays` ago: the fake store stamps an object with its clock. */
async function world() {
  const clock = new FakeClock(NOW);
  const files = new FakeFileStorage({ clock });
  const put = async (key: string, ageDays: number) => {
    clock.set(NOW - ageDays * DAY);
    await files.put(key, new Uint8Array([1]), { size: 1, contentType: 'text/markdown' });
    clock.set(NOW);
  };
  const has = (key: string) =>
    files.head(key).then(
      () => true,
      () => false,
    );
  return { files, put, has, deps: { tenants: new FakeTenantRepo(['T-a', 'T-b']), files, now: () => NOW } };
}

describe('runFailedSourceCleanup', () => {
  it('deletes the kept originals of failed pages that are older than 30 days, for every tenant, and nothing else', async () => {
    const w = await world();
    expect(FAILED_SOURCE_RETENTION_MS).toBe(30 * DAY);
    const old = [importFailedKey('T-a', 'imp1', '1'), importFailedKey('T-a', 'imp2', '7'), importFailedKey('T-b', 'imp3', '2')];
    const young = importFailedKey('T-a', 'imp4', '3');
    const zip = importZipKey('T-a', 'imp1'); // an old zip is the import cleanup's, not this run's
    const other = 'tenants/T-a/attachments/x.png';
    for (const k of old) await w.put(k, 31);
    await w.put(young, 29);
    await w.put(zip, 99);
    await w.put(other, 99);
    expect(await runFailedSourceCleanup(w.deps, live)).toBe(3);
    for (const k of old) expect(await w.has(k), k).toBe(false);
    for (const k of [young, zip, other]) expect(await w.has(k), k).toBe(true);
    expect(await runFailedSourceCleanup(w.deps, live)).toBe(0); // a second run finds nothing
  });

  it('takes more than one page of the listing, and stops at the next tenant when it is aborted', async () => {
    const w = await world();
    for (let i = 0; i < 7; i += 1) await w.put(importFailedKey('T-a', 'imp1', String(i)), 40);
    expect(await runFailedSourceCleanup({ ...w.deps, pageSize: 3 }, live)).toBe(7);
    await w.put(importFailedKey('T-b', 'imp2', '1'), 40);
    const aborted = new AbortController();
    aborted.abort();
    expect(await runFailedSourceCleanup(w.deps, aborted.signal)).toBe(0);
    expect(await w.has(importFailedKey('T-b', 'imp2', '1'))).toBe(true);
  });
});

describe('the scheduled import-cleanup', () => {
  const ctx = { jobId: 'j', attempt: 1, retryLimit: 1, signal: live };
  it('still makes up for missed cleanups when the store cannot list the kept originals, and then fails the run with that error', async () => {
    const clock = new FakeClock(NOW);
    const files = new FakeFileStorage({ clock });
    const imports = new FakeImportRepo();
    imports.seed({ id: 'imp9', tenantId: 'T-a', status: 'done', s3Key: importZipKey('T-a', 'imp9'), finishedAt: NOW - 2 * DAY });
    const w = fakeJobDeps({ clock, files, imports });
    vi.spyOn(files, 'list').mockRejectedValue(new Error('store down'));
    const job = registerJobs(w.deps).find((j) => j.name === 'import-cleanup')!;
    await expect(job.handler(undefined, ctx)).rejects.toThrow('store down');
    expect(w.logger.entries.map((e) => [e.event, e.fields])).toContainEqual(['import.reconciled', { zips: 1, pages: 0 }]);
  });

  it('runs once a day on the purge schedule with no payload, deletes the old originals and logs the count', async () => {
    const clock = new FakeClock(NOW);
    const files = new FakeFileStorage({ clock });
    const w = fakeJobDeps({ clock, files });
    const job = registerJobs(w.deps).find((j) => j.name === 'import-cleanup')!;
    expect(job.schedule).toBe(w.deps.config.jobs.purgeCron);
    const key = importFailedKey('T-a', 'imp1', '1');
    clock.set(NOW - 40 * DAY);
    await files.put(key, new Uint8Array([1]), { size: 1, contentType: 'text/markdown' });
    clock.set(NOW);
    await job.handler(undefined, ctx);
    expect(
      await files.head(key).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(w.logger.entries.map((e) => [e.event, e.fields])).toEqual([['import.sources_cleaned', { count: 1 }], ['import.reconciled', { zips: 0, pages: 0 }]]);
  });
});
