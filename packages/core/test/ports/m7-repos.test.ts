import { describe, expect, it } from 'vitest';
import { FakeImportRepo } from '../../src/testing/fake-import-repo.js';
import { FakeSearchRepo } from '../../src/testing/fake-search-repo.js';

// M7-T00: the skeleton ports and their fakes. Both are tenant-scoped: another tenant's rows are not found.
describe('FakeImportRepo', () => {
  it('finds an import in its own tenant only', async () => {
    const repo = new FakeImportRepo();
    repo.seed({ id: 'i1', tenantId: 'a', status: 'queued' });
    expect(await repo.get('a', 'i1')).toMatchObject({ id: 'i1', status: 'queued' });
    expect(await repo.get('b', 'i1')).toBeUndefined();
    expect(await repo.get('a', 'missing')).toBeUndefined();
  });
});

describe('FakeSearchRepo', () => {
  it('answers a tenant with its own pages only, and records what it was asked', async () => {
    const repo = new FakeSearchRepo();
    repo.seed({ tenantId: 'a', pageId: 'p1', urlId: 'u1', title: 'Alpha', collectionId: 'c', snippet: null, editedAt: 1, rank: 1 });
    repo.seed({ tenantId: 'b', pageId: 'p2', urlId: 'u2', title: 'Beta', collectionId: 'c', snippet: null, editedAt: 1, rank: 1 });
    const page = await repo.search({ tenantId: 'a', userId: 'u', query: 'al', limit: 10 });
    expect(page.hits.map((h) => h.pageId)).toEqual(['p1']);
    expect(repo.requests).toHaveLength(1);
  });
});
