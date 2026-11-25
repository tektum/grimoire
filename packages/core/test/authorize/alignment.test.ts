import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '../../src/authorize/authorizer.js';
import type { AccessFacts, AccessStore, CollectionFacts } from '../../src/ports/access-store.js';

const granting = (userId: string, pageId: string): AccessFacts => ({
  request: { tenantId: 'legacy', userId, pageId },
  user: { role: 'admin', suspended: false },
  page: { deleted: false, epoch: 1, collection: { deleted: false, defaultPermission: null, entries: [] } },
});

/** A store that answers in the wrong order, or with the facts of an unrelated request. */
const misaligned = (facts: readonly AccessFacts[], collectionFacts: readonly CollectionFacts[] = []): AccessStore => ({
  facts: () => Promise.resolve(facts),
  collectionFacts: () => Promise.resolve(collectionFacts),
  visibleCollections: () => Promise.resolve([]),
});

describe('facts that answer another request are never applied', () => {
  it('a reordered answer from the store denies instead of granting the wrong page', async () => {
    const authorizer = createAuthorizer(misaligned([granting('u', 'page-b'), granting('u', 'page-a')]));
    const decisions = await authorizer.checkMany([{ tenantId: 'legacy', userId: 'u', pageId: 'page-a' }, { tenantId: 'legacy', userId: 'u', pageId: 'page-b' }]);
    expect(decisions.map((d) => d.access)).toEqual(['none', 'none']);
  });

  it('facts of an unrelated user or page deny a single check', async () => {
    const authorizer = createAuthorizer(misaligned([granting('someone-else', 'page-a')]));
    expect((await authorizer.check({ tenantId: 'legacy', userId: 'u', pageId: 'page-a' })).access).toBe('none');
  });

  it('collection facts of another collection deny', async () => {
    const other: CollectionFacts = {
      request: { tenantId: 'legacy', userId: 'u', collectionId: 'c2' },
      user: { role: 'admin', suspended: false },
      collection: { deleted: false, defaultPermission: null, entries: [] },
    };
    const authorizer = createAuthorizer(misaligned([], [other]));
    expect((await authorizer.checkCollection({ tenantId: 'legacy', userId: 'u', collectionId: 'c1' })).access).toBe('none');
  });

  it('aligned facts still grant', async () => {
    const authorizer = createAuthorizer(misaligned([granting('u', 'page-a')]));
    expect((await authorizer.check({ tenantId: 'legacy', userId: 'u', pageId: 'page-a' })).access).not.toBe('none');
  });
});
