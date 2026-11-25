import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createRemoteImageFetcher } from '../../src/import/remote-images/index.js';
import { isImportPayload } from '../../src/jobs/types.js';
import { importJobs, registerJobs, type JobDeps } from '../../src/jobs/index.js';
import { fakeJobDeps } from './deps.js';

// M7-T00: the job registry and its payloads (decision 4: every payload carries the tenant, and the ids are UUIDs; nothing else).
const UUID = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999';
describe('the import job payload', () => {
  it('is a tenant id of the allowed shape and a UUID, and nothing more', () => {
    expect(isImportPayload({ tenantId: 'T3abc_-9', importId: UUID })).toBe(true);
    for (const bad of [{ importId: UUID }, { tenantId: 'a/b', importId: UUID }, { tenantId: 'x'.repeat(129), importId: UUID }, { tenantId: 'a', importId: 'not-a-uuid' },
      { tenantId: 'a', importId: UUID, key: 'tenants/a/imports/x/source.zip' }, null, 'text', []]) {
      expect(isImportPayload(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the registry of jobs', () => {
  it('lists the jobs by name with a handler each, and the cron ones with their schedule from the settings', () => {
    const jobs = registerJobs(fakeJobDeps().deps);
    expect(jobs.map((j) => j.name)).toEqual(['import', 'import-sweep', 'import-cleanup', 'purge', 'upload-cleanup', 'revision-catchup', 'markdown-sweep']);
    expect(jobs.every((j) => typeof j.handler === 'function')).toBe(true);
    expect(Object.fromEntries(jobs.map((j) => [j.name, j.schedule]))).toEqual({
      import: undefined, 'import-sweep': '*/5 * * * *', 'import-cleanup': undefined, purge: '17 3 * * *', 'upload-cleanup': '*/15 * * * *', 'revision-catchup': '47 3 * * *', 'markdown-sweep': '* * * * *',
    });
  });

  it('takes the schedules from the settings, and has no upload clean-up without a file store', () => {
    const { deps } = fakeJobDeps({ config: makeFakeConfig({ jobs: { sweepCron: '1 2 * * *', purgeCron: '3 4 * * *' } }) });
    const noFiles: { -readonly [K in keyof JobDeps]?: JobDeps[K] } = { ...deps };
    delete noFiles.files;
    const jobs = registerJobs(noFiles as JobDeps);
    expect(jobs.find((j) => j.name === 'import-sweep')?.schedule).toBe('1 2 * * *');
    expect(jobs.find((j) => j.name === 'purge')?.schedule).toBe('3 4 * * *');
    expect(jobs.map((j) => j.name)).not.toContain('upload-cleanup');
  });

  it('the import handlers refuse to run until the import exists (M7-T04), so no job is silently dropped', async () => {
    const [first] = registerJobs(fakeJobDeps().deps);
    await expect(first?.handler({ tenantId: 't', importId: UUID }, { jobId: 'j', attempt: 1, retryLimit: 1, signal: new AbortController().signal })).rejects.toThrow(/not available/);
  });

  it('runs the cron jobs against their dependencies: the purge logs what it removed, the clean-up what it cleaned', async () => {
    const { deps, logger } = fakeJobDeps();
    const ctx = { jobId: 'j', attempt: 1, retryLimit: 3, signal: new AbortController().signal };
    for (const name of ['purge', 'upload-cleanup', 'revision-catchup', 'markdown-sweep']) await registerJobs(deps).find((j) => j.name === name)?.handler(undefined, ctx);
    expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([['purge.completed', { pages: 0, objects: 0 }], ['attachments.cleaned', { count: 0 }]]);
  });

  it('is what a runner without a registry registers: the import jobs only', () => {
    expect(importJobs(makeFakeConfig()).map((j) => j.name)).toEqual(['import', 'import-sweep', 'import-cleanup']);
  });
});

describe('the remote image fetcher', () => {
  it('exists when remote images are to be fetched, and not when they are not (M7-T09)', () => {
    expect(createRemoteImageFetcher(makeFakeConfig())).toBeDefined();
    expect(createRemoteImageFetcher(makeFakeConfig({ import: { fetchRemoteImages: false } }))).toBeUndefined();
  });
});
