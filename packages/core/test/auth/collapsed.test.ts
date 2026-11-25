import { describe, expect, it } from 'vitest';
import { createPageAccess } from '../../src/authorize/index.js';
import type { AccessFacts, AccessRequest, AccessStore } from '../../src/ports/access-store.js';
import { createFakeAccessStore, emptyWorld } from '../../src/testing/fake-access-store.js';
import type { World } from '../../src/testing/fake-access-store.js';

const U = { reader: 'u-reader', writer: 'u-writer', admin: 'u-admin', none: 'u-none', suspended: 'u-suspended', viewer: 'u-viewer' };
const C = { open: 'c-open', readable: 'c-read', closed: 'c-closed', gone: 'c-gone' };
const P = { open: 'p-open', readable: 'p-read', closed: 'p-closed', deleted: 'p-deleted', inGone: 'p-in-gone', missing: 'p-missing' };

function world(): World {
  const w = emptyWorld();
  w.users.push(
    { id: U.reader, role: 'member', suspended: false }, { id: U.writer, role: 'member', suspended: false },
    { id: U.admin, role: 'admin', suspended: false }, { id: U.none, role: 'member', suspended: false },
    { id: U.suspended, role: 'admin', suspended: true }, { id: U.viewer, role: 'viewer', suspended: false },
  );
  w.collections.push(
    { id: C.open, deleted: false, defaultPermission: 'read_write' }, { id: C.readable, deleted: false, defaultPermission: 'read' },
    { id: C.closed, deleted: false, defaultPermission: null }, { id: C.gone, deleted: true, defaultPermission: 'read_write' },
  );
  w.access.push({ collectionId: C.closed, userId: U.writer, permission: 'read_write' }, { collectionId: C.closed, userId: U.reader, permission: 'read' });
  w.pages.push(
    { id: P.open, collectionId: C.open, deleted: false, epoch: 3 }, { id: P.readable, collectionId: C.readable, deleted: false, epoch: 4 },
    { id: P.closed, collectionId: C.closed, deleted: false, epoch: 5 }, { id: P.deleted, collectionId: C.open, deleted: true, epoch: 6 },
    { id: P.inGone, collectionId: C.gone, deleted: false, epoch: 7 },
  );
  return w;
}

/** Counts store round trips, so a refusal can be shown to consult the database exactly like an admission. */
function counting(store: AccessStore): AccessStore & { calls: number } {
  const c = { calls: 0 };
  return Object.assign(c, {
    facts: (rs: readonly AccessRequest[]) => { c.calls++; return store.facts(rs); },
    collectionFacts: store.collectionFacts.bind(store),
    visibleCollections: store.visibleCollections.bind(store),
  });
}

describe('collapsed page access (R6.4): one answer for every denial, so existence never leaks', () => {
  const access = createPageAccess(createFakeAccessStore(world()));

  it.each([
    ['missing page', U.writer, P.missing],
    ['deleted page', U.admin, P.deleted],
    ['page in a deleted collection', U.admin, P.inGone],
    ['no access to the collection', U.none, P.closed],
    ['no user row', 'u-unknown', P.open],
    ['suspended user, even admin', U.suspended, P.open],
  ])('%s -> not-found, the identical value from every form', async (_label, userId, pageId) => {
    const r = { tenantId: 'legacy', userId, pageId };
    expect(await access.checkAccess(r)).toBe('not-found');
    expect(await access.checkAccessMany([r])).toEqual(['not-found']);
    expect(await access.pageAccess(r)).toStrictEqual({ result: 'not-found' });
    expect(await access.pageAccessMany([r])).toStrictEqual([{ result: 'not-found' }]);
  });

  it('allowed carries the level and epoch for the host; the plain form says only allowed', async () => {
    expect(await access.pageAccess({ tenantId: 'legacy', userId: U.writer, pageId: P.closed })).toStrictEqual({ result: 'allowed', access: 'read-write', epoch: 5 });
    expect(await access.pageAccess({ tenantId: 'legacy', userId: U.reader, pageId: P.closed })).toStrictEqual({ result: 'allowed', access: 'read-only', epoch: 5 });
    expect(await access.pageAccess({ tenantId: 'legacy', userId: U.viewer, pageId: P.open })).toStrictEqual({ result: 'allowed', access: 'read-only', epoch: 3 });
    expect(await access.checkAccess({ tenantId: 'legacy', userId: U.reader, pageId: P.readable })).toBe('allowed');
  });

  it('read but not write is the only case that is told apart: allowed at read-only, never not-found', async () => {
    const d = await access.pageAccess({ tenantId: 'legacy', userId: U.reader, pageId: P.readable });
    expect(d).toStrictEqual({ result: 'allowed', access: 'read-only', epoch: 4 });
  });

  it('many: one store round trip, same order', async () => {
    const store = counting(createFakeAccessStore(world()));
    const a = createPageAccess(store);
    const rs = [{ tenantId: 'legacy', userId: U.writer, pageId: P.missing }, { tenantId: 'legacy', userId: U.writer, pageId: P.open }, { tenantId: 'legacy', userId: U.none, pageId: P.closed }];
    expect(await a.checkAccessMany(rs)).toEqual(['not-found', 'allowed', 'not-found']);
    expect(store.calls).toBe(1);
  });

  it('a missing page and a forbidden page cost the same: one store call each, no early return before it', async () => {
    const store = counting(createFakeAccessStore(world()));
    const a = createPageAccess(store);
    await a.pageAccess({ tenantId: 'legacy', userId: U.none, pageId: P.missing });
    expect(store.calls).toBe(1);
    await a.pageAccess({ tenantId: 'legacy', userId: U.none, pageId: P.closed });
    expect(store.calls).toBe(2);
  });

  it('includeDeleted reaches the decision (trash routes)', async () => {
    expect(await access.checkAccess({ tenantId: 'legacy', userId: U.admin, pageId: P.deleted }, { includeDeleted: true })).toBe('allowed');
    expect(await access.checkAccessMany([{ tenantId: 'legacy', userId: U.admin, pageId: P.deleted }], { includeDeleted: true })).toEqual(['allowed']);
  });

  it('a store that rejects makes the call reject: no answer is invented', async () => {
    const broken: AccessStore = { facts: () => Promise.reject(new Error('db down')), collectionFacts: () => Promise.reject(new Error('x')), visibleCollections: () => Promise.reject(new Error('x')) };
    await expect(createPageAccess(broken).pageAccess({ tenantId: 'legacy', userId: U.admin, pageId: P.open })).rejects.toThrow();
    await expect(createPageAccess(broken).checkAccess({ tenantId: 'legacy', userId: U.admin, pageId: P.open })).rejects.toThrow();
  });

  it('facts for another request, too few facts, or facts out of order are denied (fail closed)', async () => {
    const real = createFakeAccessStore(world());
    const swapped: AccessStore = { ...real, facts: async (rs) => [...(await real.facts(rs))].reverse() };
    const short: AccessStore = { ...real, facts: async (rs) => (await real.facts(rs)).slice(1) };
    const other: AccessStore = { ...real, facts: async (rs) => real.facts(rs.map((r) => ({ ...r, userId: U.admin }))) };
    const rs = [{ tenantId: 'legacy', userId: U.none, pageId: P.closed }, { tenantId: 'legacy', userId: U.writer, pageId: P.open }];
    expect(await createPageAccess(swapped).pageAccessMany(rs)).toStrictEqual([{ result: 'not-found' }, { result: 'not-found' }]);
    expect(await createPageAccess(short).pageAccessMany(rs)).toStrictEqual([{ result: 'not-found' }, { result: 'not-found' }]);
    expect(await createPageAccess(other).pageAccess({ tenantId: 'legacy', userId: U.none, pageId: P.closed })).toStrictEqual({ result: 'not-found' });
  });

  it('a decision with an unknown access value is not-found (default deny of the collapsing itself)', async () => {
    const weird: AccessStore = {
      ...createFakeAccessStore(world()),
      facts: (rs) => Promise.resolve(rs.map((request): AccessFacts => ({ request, user: { role: 'superuser' as never, suspended: false }, page: { deleted: false, epoch: 1, collection: { deleted: false, defaultPermission: 'read_write', entries: [] } } }))),
    };
    expect(await createPageAccess(weird).pageAccess({ tenantId: 'legacy', userId: U.admin, pageId: P.open })).toStrictEqual({ result: 'not-found' });
  });
});
