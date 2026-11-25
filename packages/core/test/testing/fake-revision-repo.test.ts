import { describe, expect, it } from 'vitest';
import { FakeRevisionRepo } from '../../src/testing/fake-revision-repo.js';

// As the PostgreSQL adapter (db-kysely pages-tenancy.int.test.ts): a page of another tenant is no page, and no safety copy is made of it.
describe('FakeRevisionRepo.snapshotBeforeRestore across tenants', () => {
  it('answers no-page to another tenant and copies the page for its own', async () => {
    const repo = new FakeRevisionRepo();
    repo.pageTenants.set('p', 'T-a');
    repo.setPage('p', { title: 'Title', markdown: 'Text' });
    expect(await repo.snapshotBeforeRestore('T-b', 'p')).toEqual({ kind: 'no-page' });
    expect(repo.made('p')).toEqual([]);
    expect((await repo.snapshotBeforeRestore('T-a', 'p')).kind).toBe('created');
  });
});
