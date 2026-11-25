import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '../../src/authorize/authorizer.js';
import { decide, decideCollection } from '../../src/authorize/decide.js';
import type { AccessDecision, CollectionDecision } from '../../src/authorize/decide.js';
import { accessCases, collectionExpectOf, collectionFactsOfCase, collectionReason, factsOfCase, worldOfCases } from '../../src/testing/access-cases.js';
import type { Expected } from '../../src/testing/access-cases.js';
import { createFakeAccessStore } from '../../src/testing/fake-access-store.js';
import type { AccessFacts } from '../../src/ports/access-store.js';
import type { Role } from '../../src/ports/user-store.js';

const { world, ids } = worldOfCases();
const levelOrReason = (d: AccessDecision | CollectionDecision): Expected => (d.access === 'none' ? d.reason : d.access);

describe('access table', () => {
  it('has at least 40 rows, no viewer row expects read-write, every suspended row expects suspended', () => {
    expect(accessCases.length).toBeGreaterThanOrEqual(40);
    expect(accessCases.filter((c) => c.role === 'viewer' && c.expect === 'read-write')).toEqual([]);
    for (const c of accessCases.filter((x) => x.suspended)) expect(c.expect, c.name).toBe('suspended');
    expect(new Set(accessCases.map((c) => c.name)).size).toBe(accessCases.length);
  });
});

describe('decide, row by row', () => {
  accessCases.forEach((c, i) => {
    const id = ids[i];
    it(c.name, () => {
      if (!id) throw new Error('row without ids');
      const d = decide(factsOfCase(c, id, i + 1), { includeDeleted: c.includeDeleted });
      expect(levelOrReason(d)).toBe(c.expect);
      if (d.access !== 'none') expect(d.epoch).toBe(i + 1);
    });
  });
});

describe('decideCollection, the same rows', () => {
  accessCases.forEach((c, i) => {
    const id = ids[i];
    const want = collectionExpectOf(c);
    if (want === 'skip') return;
    it(c.name, () => {
      if (!id) throw new Error('row without ids');
      expect(levelOrReason(decideCollection(collectionFactsOfCase(c, id), { includeDeleted: c.includeDeleted }))).toBe(want);
    });
  });
});

describe('createAuthorizer over the fake store, the same rows', () => {
  const authorizer = createAuthorizer(createFakeAccessStore(world));
  it('check agrees with the table for every row', async () => {
    for (const [i, c] of accessCases.entries()) {
      const id = ids[i];
      if (!id) throw new Error('row without ids');
      const d = await authorizer.check({ tenantId: 'legacy', userId: id.userId, pageId: id.pageId }, { includeDeleted: c.includeDeleted });
      expect(levelOrReason(d), c.name).toBe(c.expect);
    }
  });
  it('checkMany gives the answers of the rows without includeDeleted, in order', async () => {
    const rows = accessCases.map((c, i) => ({ c, id: ids[i] })).filter((x) => !x.c.includeDeleted);
    const out = await authorizer.checkMany(rows.map((x) => ({ tenantId: 'legacy', userId: x.id?.userId ?? '', pageId: x.id?.pageId ?? '' })));
    expect(out.map(levelOrReason)).toEqual(rows.map((x) => x.c.expect));
  });
  it('checkCollection agrees with the collection rows', async () => {
    for (const [i, c] of accessCases.entries()) {
      const id = ids[i];
      const want = collectionExpectOf(c);
      if (!id || want === 'skip') continue;
      const d = await authorizer.checkCollection({ tenantId: 'legacy', userId: id.userId, collectionId: id.collectionId }, { includeDeleted: c.includeDeleted });
      expect(levelOrReason(d), c.name).toBe(want);
    }
  });
  it('visibleCollections agrees with checkCollection for every collection and user of the world', async () => {
    for (const includeDeleted of [false, true]) {
      for (const u of world.users) {
        const listed = new Map((await authorizer.visibleCollections('legacy', u.id, { includeDeleted })).map((r) => [r.collectionId, r.access]));
        for (const col of world.collections) {
          const d = await authorizer.checkCollection({ tenantId: 'legacy', userId: u.id, collectionId: col.id }, { includeDeleted });
          expect(listed.get(col.id) ?? 'none').toBe(d.access);
        }
      }
    }
  });
  it('a store that rejects makes check reject, and a store that answers short is denied', async () => {
    const failing = createAuthorizer({ facts: () => Promise.reject(new Error('down')), collectionFacts: () => Promise.reject(new Error('down')), visibleCollections: () => Promise.reject(new Error('down')) });
    await expect(failing.check({ tenantId: 'legacy', userId: 'u', pageId: 'p' })).rejects.toThrow();
    const short = createAuthorizer({ facts: () => Promise.resolve([]), collectionFacts: () => Promise.resolve([]), visibleCollections: () => Promise.resolve([]) });
    expect(await short.check({ tenantId: 'legacy', userId: 'u', pageId: 'p' })).toEqual({ access: 'none', reason: 'no-user' });
    expect(await short.checkMany([{ tenantId: 'legacy', userId: 'u', pageId: 'p' }])).toEqual([{ access: 'none', reason: 'no-user' }]);
    expect(await short.checkCollection({ tenantId: 'legacy', userId: 'u', collectionId: 'c' })).toEqual({ access: 'none', reason: 'no-user' });
  });
});

describe('default deny', () => {
  const live = { deleted: false, defaultPermission: 'read_write' as const, entries: [] as const };
  const base = (over: Partial<AccessFacts>): AccessFacts => ({ request: { tenantId: 'legacy', userId: 'u', pageId: 'p' }, user: { role: 'member', suspended: false }, page: { deleted: false, epoch: 1, collection: live }, ...over });
  it('refuses an unknown role', () => {
    const user = { role: 'owner' as unknown as Role, suspended: false };
    expect(decide(base({ user }))).toEqual({ access: 'none', reason: 'no-access' });
    expect(decideCollection({ request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' }, user, collection: live })).toEqual({ access: 'none', reason: 'no-access' });
  });
  it('ignores unknown permissions in the entries and the default', () => {
    const bad = 'write' as unknown as 'read';
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: { deleted: false, defaultPermission: bad, entries: [bad] } } }))).toEqual({ access: 'none', reason: 'no-access' });
  });
  it('treats a flag that is not literally false as set', () => {
    expect(decide(base({ user: { role: 'admin', suspended: undefined as unknown as boolean } }))).toEqual({ access: 'none', reason: 'suspended' });
    expect(decide(base({ page: { deleted: undefined as unknown as boolean, epoch: 1, collection: live } }))).toEqual({ access: 'none', reason: 'deleted' });
  });
  it.each([-1, 1.5, Number.NaN, Infinity])('refuses the epoch %s, which is not a non-negative integer', (epoch) => {
    expect(decide(base({ page: { deleted: false, epoch, collection: live } }))).toEqual({ access: 'none', reason: 'no-page' });
  });
  it('refuses entries that are not an array', () => {
    const entries = 'read_write' as unknown as readonly 'read'[];
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: { deleted: false, defaultPermission: null, entries } } }))).toEqual({ access: 'none', reason: 'no-access' });
  });
  const perms = [null, 'read', 'read_write'] as const;
  const unknownRoleCases = perms.flatMap((defaultPermission) => (['read', 'read_write'] as const).map((entry) => ({ defaultPermission, entry })));
  it.each(unknownRoleCases)('grants nothing to an unknown role, default $defaultPermission and entry $entry, page or collection', ({ defaultPermission, entry }) => {
    const user = { role: 'owner' as unknown as Role, suspended: false };
    const collection = { deleted: false, defaultPermission, entries: [entry] };
    expect(decide(base({ user, page: { deleted: false, epoch: 1, collection } }))).toEqual({ access: 'none', reason: 'no-access' });
    expect(decideCollection({ request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' }, user, collection })).toEqual({ access: 'none', reason: 'no-access' });
  });
  const cf = (user: { role: Role; suspended: boolean }, collection: { deleted: boolean; defaultPermission: 'read_write'; entries: readonly 'read'[] }) =>
    ({ request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' }, user, collection });
  const notFalse: [string, string | number | undefined][] = [['undefined', undefined], ["the string 'false'", 'false'], ['0', 0]];
  it.each(notFalse)('collection form: suspended given as %s is treated as set', (_n, v) => {
    expect(decideCollection(cf({ role: 'admin', suspended: v as unknown as boolean }, live))).toEqual({ access: 'none', reason: 'suspended' });
  });
  it.each(notFalse)('collection form: deleted given as %s is treated as set', (_n, v) => {
    expect(decideCollection(cf({ role: 'admin', suspended: false }, { ...live, deleted: v as unknown as boolean }))).toEqual({ access: 'none', reason: 'deleted' });
  });
  it.each([["the string 'yes'", 'yes'], ['1', 1]])('collection form: includeDeleted given as %s does not lift a deleted collection', (_n, v) => {
    const gone = { ...live, deleted: true };
    expect(decideCollection(cf({ role: 'admin', suspended: false }, gone), { includeDeleted: v as unknown as boolean })).toEqual({ access: 'none', reason: 'deleted' });
  });
  it('refuses entries that are iterable but not an array, even when every item is a valid permission', () => {
    const entries = new Set(['read_write']) as unknown as readonly 'read'[];
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: { deleted: false, defaultPermission: null, entries } } }))).toEqual({ access: 'none', reason: 'no-access' });
    expect(decideCollection({ request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' }, user: { role: 'member', suspended: false }, collection: { deleted: false, defaultPermission: null, entries } })).toEqual({ access: 'none', reason: 'no-access' });
  });
  it('accepts epoch 0 as a real epoch', () => {
    expect(decide(base({ page: { deleted: false, epoch: 0, collection: live } }))).toEqual({ access: 'read-write', epoch: 0 });
  });
  it('refuses a deleted page or collection when no options are passed, and lifts it only for includeDeleted true', () => {
    const gone = { ...live, deleted: true };
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: gone } }))).toEqual({ access: 'none', reason: 'deleted' });
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: gone } }), {})).toEqual({ access: 'none', reason: 'deleted' });
    expect(decide(base({ page: { deleted: false, epoch: 1, collection: gone } }), { includeDeleted: true })).toEqual({ access: 'read-write', epoch: 1 });
    expect(decideCollection({ request: { tenantId: 'legacy', userId: 'u', collectionId: 'c' }, user: { role: 'member', suspended: false }, collection: gone })).toEqual({ access: 'none', reason: 'deleted' });
  });
  it('includeDeleted only lifts the deleted check', () => {
    expect(decide({ request: { tenantId: 'legacy', userId: 'u', pageId: 'p' } }, { includeDeleted: true })).toEqual({ access: 'none', reason: 'no-user' });
    expect(decide({ request: { tenantId: 'legacy', userId: 'u', pageId: 'p' }, user: { role: 'member', suspended: false } }, { includeDeleted: true })).toEqual({ access: 'none', reason: 'no-page' });
    expect(collectionReason('no-page')).toBe('no-collection');
  });
});
