import { describe, expect, it } from 'vitest';
import { createPageAccess } from '../../src/authorize/index.js';
import { decide, decideCollection } from '../../src/authorize/decide.js';
import type { AccessFacts, AccessRequest, AccessStore } from '../../src/ports/access-store.js';

// docs/tenancy.md, sections 3.3 and 3.4 (tests of section 7, items 1 and 2): the person and the page must be of one tenant, whatever else says yes. A page of another
// tenant is refused as a page that is not there (never as a forbidden one), by the same decision the collaboration handshake, its re-check and the page routes use.
const collection = { deleted: false, defaultPermission: 'read_write' as const, entries: [] };
const facts = (user: string | undefined, page: string | undefined, role: 'admin' | 'member' | 'viewer' = 'member'): AccessFacts => ({
  request: { tenantId: 'legacy', userId: 'u', pageId: 'p' },
  user: { role, suspended: false, ...(user === undefined ? {} : { tenantId: user }) },
  page: { deleted: false, epoch: 3, collection, ...(page === undefined ? {} : { tenantId: page }) },
});

describe('a person and a page of different tenants', () => {
  it.each(['admin', 'member', 'viewer'] as const)('a %s of tenant A gets nothing on a page of tenant B, and it is the answer for a page that is not there', (role) => {
    expect(decide(facts('A', 'B', role))).toEqual({ access: 'none', reason: 'no-page' });
  });

  it('is the same answer however generous the collection is (a default of read and write, an administrator)', () => {
    const noPage: AccessFacts = { request: { tenantId: 'legacy', userId: 'u', pageId: 'p' }, user: facts('A', 'B', 'admin').user! };
    expect(decide(facts('A', 'B', 'admin'))).toEqual(decide(noPage));
  });

  it('is refused for a trashed page too, and with the trash routes asking for deleted pages (includeDeleted does not reach across tenants)', () => {
    const trashed: AccessFacts = { ...facts('A', 'B'), page: { deleted: true, epoch: 1, collection, tenantId: 'B' } };
    expect(decide(trashed, { includeDeleted: true })).toEqual({ access: 'none', reason: 'no-page' });
  });

  it('gets the level it has in its own tenant when the tenants are the same', () => {
    expect(decide(facts('A', 'A'))).toEqual({ access: 'read-write', epoch: 3 });
    expect(decide(facts('A', 'A', 'viewer'))).toEqual({ access: 'read-only', epoch: 3 });
  });

  it('is refused when only one of the two says its tenant (a store that forgot one column denies, it does not grant)', () => {
    expect(decide(facts('A', undefined))).toEqual({ access: 'none', reason: 'no-page' });
    expect(decide(facts(undefined, 'A'))).toEqual({ access: 'none', reason: 'no-page' });
  });

  it('is unchanged for a store that knows nothing of tenants (neither says one)', () => {
    expect(decide(facts(undefined, undefined))).toEqual({ access: 'read-write', epoch: 3 });
  });

  it('keeps the other refusals first in their order: a suspended person is suspended, a missing user is no user, whatever the tenants', () => {
    expect(decide({ ...facts('A', 'B'), user: { role: 'member', suspended: true, tenantId: 'A' } })).toEqual({ access: 'none', reason: 'suspended' });
    expect(decide({ request: { tenantId: 'legacy', userId: 'u', pageId: 'p' }, page: facts('A', 'B').page! })).toEqual({ access: 'none', reason: 'no-user' });
  });
});

describe('the collapsed answer the host and the routes use', () => {
  const store = (rows: Record<string, AccessFacts>): AccessStore => ({
    facts: async (requests: readonly AccessRequest[]) => requests.map((r) => rows[`${r.userId}:${r.pageId}`] ?? { request: r }),
    collectionFacts: async () => [],
    visibleCollections: async () => [],
  });
  const access = createPageAccess(store({ 'a:pa': { ...facts('A', 'A'), request: { tenantId: 'legacy', userId: 'a', pageId: 'pa' } }, 'a:pb': { ...facts('A', 'B'), request: { tenantId: 'legacy', userId: 'a', pageId: 'pb' } } }));

  it('says not-found for the page of another tenant, as for no page at all, and allowed for the own', async () => {
    expect(await access.pageAccess({ tenantId: 'legacy', userId: 'a', pageId: 'pb' })).toEqual({ result: 'not-found' });
    expect(await access.pageAccess({ tenantId: 'legacy', userId: 'a', pageId: 'nothing' })).toEqual({ result: 'not-found' });
    expect(await access.pageAccess({ tenantId: 'legacy', userId: 'a', pageId: 'pa' })).toEqual({ result: 'allowed', access: 'read-write', epoch: 3 });
  });

  it('takes the same one round trip for the re-check of many, and drops only the page of the other tenant', async () => {
    expect(await access.pageAccessMany([{ tenantId: 'legacy', userId: 'a', pageId: 'pa' }, { tenantId: 'legacy', userId: 'a', pageId: 'pb' }])).toEqual([{ result: 'allowed', access: 'read-write', epoch: 3 }, { result: 'not-found' }]);
  });
});

describe('a collection of another tenant (docs/tenancy.md, 3.3)', () => {
  const inCollection = (user: string | undefined, collection: string | undefined, role: 'admin' | 'member' | 'viewer' = 'member') => ({
    request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' },
    user: { role, suspended: false, ...(user === undefined ? {} : { tenantId: user }) },
    collection: { deleted: false, defaultPermission: 'read_write' as const, entries: [], ...(collection === undefined ? {} : { tenantId: collection }) },
  });

  it.each(['admin', 'member', 'viewer'] as const)('gives a %s of tenant A nothing in a collection of tenant B, as for a collection that is not there', (role) => {
    expect(decideCollection(inCollection('A', 'B', role))).toEqual({ access: 'none', reason: 'no-collection' });
    expect(decideCollection(inCollection('A', 'A', role)).access).not.toBe('none');
  });

  it('denies when only one of the two says its tenant, and is unchanged when neither does', () => {
    expect(decideCollection(inCollection('A', undefined))).toEqual({ access: 'none', reason: 'no-collection' });
    expect(decideCollection(inCollection(undefined, 'A'))).toEqual({ access: 'none', reason: 'no-collection' });
    expect(decideCollection(inCollection(undefined, undefined)).access).toBe('read-write');
  });

  it('keeps the earlier refusals first: no user, suspended', () => {
    expect(decideCollection({ ...inCollection('A', 'B'), user: { role: 'member', suspended: true, tenantId: 'A' } })).toEqual({ access: 'none', reason: 'suspended' });
  });
});
