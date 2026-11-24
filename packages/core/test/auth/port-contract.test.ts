import { expect, expectTypeOf, it } from 'vitest';
import type { AuthVerifier, Profile, ProfileResult, VerifyResult } from '../../src/ports/auth-verifier.js';
import type { CreateUserResult, Role, UserRecord, UserStore } from '../../src/ports/user-store.js';
import type { AccessFacts, AccessOptions, AccessRequest, AccessStore, CollectionAccessRequest, CollectionFacts, Permission } from '../../src/ports/access-store.js';

const accessStore: AccessStore = {
  facts: async (requests: readonly AccessRequest[]) => requests.map((request): AccessFacts => ({ request })),
  collectionFacts: async (requests: readonly CollectionAccessRequest[]) => requests.map((request): CollectionFacts => ({ request })),
  async visibleCollections(userId: string, opts?: AccessOptions): Promise<readonly { collectionId: string; access: 'read-write' | 'read-only' }[]> {
    void userId;
    void opts;
    return [];
  },
};
const userStore: UserStore = {
  findByDescopeId: () => Promise.resolve(undefined),
  createIfAbsent: async (n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role }): Promise<CreateUserResult> => { void n; return { kind: 'email-taken' }; },
  updateRole: () => Promise.resolve(undefined),
};const profile: Profile = { email: 'u@example.test', name: 'u', emailVerified: true };
const profileResult: ProfileResult = { kind: 'ok', profile };
const verifyResult: VerifyResult = { kind: 'ok', userId: 'u', expiresAt: 1, profile };
const permission: Permission = 'read_write';
const userRecord: UserRecord = { id: 'u', descopeUserId: 'd', email: profile.email, name: 'u', role: 'member', suspended: false, tenantId: 'legacy' };
const verifier: AuthVerifier = {
  async verify(token: string): Promise<VerifyResult> { void token; return verifyResult; },
  async profile(userId: string): Promise<ProfileResult> { void userId; return profileResult; },
};

const collectionFacts: CollectionFacts = {
  request: { userId: 'u', collectionId: 'c' },
  collection: { deleted: false, defaultPermission: null, entries: [permission] },
};
const options: AccessOptions = { includeDeleted: true };

it('imports every AccessStore port name and checks its exact query signatures', async () => {
  expectTypeOf(accessStore.facts([{ userId: 'u', pageId: 'p' }])).toEqualTypeOf<Promise<readonly AccessFacts[]>>();
  expectTypeOf(accessStore.collectionFacts([collectionFacts.request])).toEqualTypeOf<Promise<readonly CollectionFacts[]>>();
  expectTypeOf(accessStore.visibleCollections('u', options)).toEqualTypeOf<Promise<readonly { collectionId: string; access: 'read-write' | 'read-only' }[]>>();
  expect(await accessStore.facts([{ userId: 'u', pageId: 'p' }])).toEqual([{ request: { userId: 'u', pageId: 'p' } }]);
  expect(await accessStore.collectionFacts([collectionFacts.request])).toEqual([{ request: collectionFacts.request }]);
  expect(await accessStore.visibleCollections('u', options)).toEqual([]);
  expectTypeOf<keyof AccessFacts>().toEqualTypeOf<'request' | 'user' | 'page'>();
  expectTypeOf<keyof CollectionFacts>().toEqualTypeOf<'request' | 'user' | 'collection'>();
});

it('imports all auth-verifier and user-store contract names with their defined methods', async () => {
  expectTypeOf<keyof AuthVerifier>().toEqualTypeOf<'verify' | 'profile'>();
  expectTypeOf<keyof UserStore>().toEqualTypeOf<'findByDescopeId' | 'createIfAbsent' | 'updateRole'>();
  expect(userRecord.role).toBe('member');
  expectTypeOf<ProfileResult>().toEqualTypeOf<{ kind: 'ok'; profile: Profile } | { kind: 'unavailable' } | { kind: 'not-configured' }>();
  expect(await verifier.verify('test-token')).toEqual(verifyResult);
  expect(await verifier.profile?.('u')).toEqual(profileResult);
  await expect(userStore.findByDescopeId('d')).resolves.toBeUndefined();
  await expect(userStore.createIfAbsent({ descopeUserId: 'd', email: profile.email, name: 'u', role: 'member' })).resolves.toEqual({ kind: 'email-taken' });
  await expect(userStore.updateRole('u', 'member')).resolves.toBeUndefined();
});
