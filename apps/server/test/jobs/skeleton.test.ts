import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createRemoteImageFetcher } from '../../src/import/remote-images/index.js';
import { isImportPayload } from '../../src/jobs/types.js';
import { registerJobs } from '../../src/jobs/index.js';

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
  it('lists the three import jobs by name with a handler each, and the sweep has a schedule', () => {
    const jobs = registerJobs({ config: makeFakeConfig() });
    expect(jobs.map((j) => j.name)).toEqual(['import', 'import-sweep', 'import-cleanup']);
    expect(jobs.every((j) => typeof j.handler === 'function')).toBe(true);
    expect(jobs.find((j) => j.name === 'import-sweep')?.schedule).toBe('*/5 * * * *');
  });

  it('takes the sweep schedule from the settings', () => {
    expect(registerJobs({ config: makeFakeConfig({ jobs: { sweepCron: '1 2 * * *' } }) }).find((j) => j.name === 'import-sweep')?.schedule).toBe('1 2 * * *');
  });

  it('the stub handlers refuse to run until the import exists (M7-T04), so no job is silently dropped', async () => {
    const [first] = registerJobs({ config: makeFakeConfig() });
    await expect(first?.handler({ tenantId: 't', importId: UUID }, { jobId: 'j', attempt: 1, retryLimit: 1, signal: new AbortController().signal })).rejects.toThrow(/not available/);
  });
});

describe('the remote image fetcher', () => {
  it('exists when remote images are to be fetched, and not when they are not (M7-T09)', () => {
    expect(createRemoteImageFetcher(makeFakeConfig())).toBeDefined();
    expect(createRemoteImageFetcher(makeFakeConfig({ import: { fetchRemoteImages: false } }))).toBeUndefined();
  });
});
