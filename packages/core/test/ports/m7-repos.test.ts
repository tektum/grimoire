import { describe, expect, it } from 'vitest';
import { importRepoConformance } from '../../src/testing/import-repo-conformance.js';
import { FakeImportRepo } from '../../src/testing/fake-import-repo.js';
import { SearchTimeoutError } from '../../src/ports/search-repo.js';
import { FakeSearchRepo } from '../../src/testing/fake-search-repo.js';

// M7-T00: the skeleton ports and their fakes. Both are tenant-scoped: another tenant's rows are not found.
describe('FakeImportRepo', () => {
  it('finds an import in its own tenant only', async () => {
    const repo = new FakeImportRepo();
    repo.seed({ id: 'i1', tenantId: 'a', status: 'created' });
    expect(await repo.get('a', 'i1')).toMatchObject({ id: 'i1', status: 'created' });
    expect(await repo.get('b', 'i1')).toBeUndefined();
    expect(await repo.get('a', 'missing')).toBeUndefined();
  });

  for (const c of importRepoConformance) {
    it(`meets the conformance case ${c.name}`, async () => {
      const repo = new FakeImportRepo();
      let n = 0;
      await c.run({ repo, tenantId: 'a', otherTenantId: 'b', userId: 'u', now: 1_700_000_000_000, seedStatus: (id, status) => { repo.setStatus(id, status); return Promise.resolve(); }, seed: (status) => Promise.resolve(repo.seed({ id: `imp${String(++n)}`, tenantId: 'a', status })) });
    });
  }
});

describe('FakeSearchRepo', () => {
  const hit = (tenantId: string, pageId: string, collectionId: string) => ({ tenantId, pageId, urlId: `u-${pageId}`, title: pageId, collectionId, snippet: { text: '', ranges: [] }, partial: false, updatedAt: 1, rank: 1 });

  it('answers a tenant with its own pages in the collections it may read, and records what it was asked', async () => {
    const repo = new FakeSearchRepo();
    repo.seed(hit('a', 'p1', 'c1'));
    repo.seed(hit('b', 'p2', 'c1'));
    repo.seed(hit('a', 'p3', 'c2'));
    repo.seed(hit('a', 'p4', 'c3'));
    expect((await repo.search({ tenantId: 'a', collectionIds: ['c1', 'c2'], query: 'al', limit: 10 })).hits.map((h) => h.pageId)).toEqual(['p1', 'p3']);
    expect((await repo.search({ tenantId: 'a', collectionIds: ['c1', 'c2'], query: 'al', limit: 10, collectionId: 'c2' })).hits.map((h) => h.pageId)).toEqual(['p3']);
    expect((await repo.search({ tenantId: 'a', collectionIds: ['c1'], query: 'al', limit: 10, collectionId: 'c2' })).hits).toEqual([]);
    expect(repo.requests).toHaveLength(3);
  });

  it('rejects once with the error it was given', async () => {
    const repo = new FakeSearchRepo();
    repo.failNext = new Error('boom');
    await expect(repo.search({ tenantId: 'a', collectionIds: [], query: 'x', limit: 1 })).rejects.toThrow('boom');
    expect((await repo.search({ tenantId: 'a', collectionIds: [], query: 'x', limit: 1 })).hits).toEqual([]);
  });
});

describe('SearchTimeoutError', () => {
  it('is an error a route can recognise by its class', () => {
    const error = new SearchTimeoutError();
    expect([error instanceof Error, error.name]).toEqual([true, 'SearchTimeoutError']);
  });
});
