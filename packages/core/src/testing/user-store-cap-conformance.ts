import assert from 'node:assert/strict';
import type { UserStore } from '../ports/user-store.js';

/** A store with a cap of two people for each tenant (a fresh one for each case, in a tenant no other case uses). */
export interface UserStoreCapHarness { readonly store: UserStore; readonly tenant: string }
export interface UserStoreCapCase { readonly name: string; run(h: UserStoreCapHarness): Promise<void> }

const person = (h: UserStoreCapHarness, n: string, over: { email?: string; descopeUserId?: string } = {}) => ({
  descopeUserId: over.descopeUserId ?? `${h.tenant}-${n}`, email: over.email ?? `${n}@${h.tenant}.test`, name: n, role: 'member' as const, tenant: { id: h.tenant, name: `${h.tenant}.test` },
});

/**
 * The order in which a new person is judged, the same in every store (the adapter and the fake): a person who has a row is that person (`existing`), whatever the count; then an email
 * another person has is `email-taken`; only then the cap. So a duplicate in a full tenant gets the answer of the duplicate, not `tenant-full`.
 */
export const userStoreCapCases: readonly UserStoreCapCase[] = [
  {
    name: 'a person who has a row is returned as existing in a full tenant',
    async run(h) {
      await h.store.createIfAbsent(person(h, 'a'));
      await h.store.createIfAbsent(person(h, 'b'));
      assert.equal((await h.store.createIfAbsent(person(h, 'a'))).kind, 'existing');
    },
  },
  {
    name: 'an email another person has is email-taken in a full tenant, not tenant-full',
    async run(h) {
      await h.store.createIfAbsent(person(h, 'a'));
      await h.store.createIfAbsent(person(h, 'b'));
      const duplicate = await h.store.createIfAbsent(person(h, 'c', { email: `A@${h.tenant}.test` }));
      assert.deepEqual(duplicate, { kind: 'email-taken' });
    },
  },
  {
    name: 'a new person with a new email is tenant-full in a full tenant, and nothing is made',
    async run(h) {
      await h.store.createIfAbsent(person(h, 'a'));
      await h.store.createIfAbsent(person(h, 'b'));
      assert.deepEqual(await h.store.createIfAbsent(person(h, 'c')), { kind: 'tenant-full' });
      assert.equal(await h.store.findByDescopeId(`${h.tenant}-c`), undefined);
    },
  },
  {
    name: 'an email taken in a tenant that is not full is email-taken too',
    async run(h) {
      await h.store.createIfAbsent(person(h, 'a'));
      assert.deepEqual(await h.store.createIfAbsent(person(h, 'c', { email: `a@${h.tenant}.test` })), { kind: 'email-taken' });
    },
  },
];
