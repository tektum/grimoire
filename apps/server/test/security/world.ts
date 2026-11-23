import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AdminUser } from '@tektum/grimoire-core/ports/admin-repo';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAdminRepo } from '@tektum/grimoire-core/testing/fake-admin-repo';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakePageStateRepo } from '@tektum/grimoire-core/testing/fake-page-state-repo';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';
import type { Operation } from './document.js';

/** Who the walk signs in as. The token is the name; `garbage` and `expired` are tokens the verifier refuses. */
export type Who = 'admin' | 'member' | 'viewer' | 'suspended' | 'former' | 'garbage' | 'expired';

const NAMES = ['admin', 'member', 'viewer', 'suspended', 'former'] as const;
const ROLE: Record<(typeof NAMES)[number], Role> = { admin: 'admin', member: 'member', viewer: 'viewer', suspended: 'member', former: 'member' };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const NIL = uuid(0);
export const USER_ID = Object.fromEntries(NAMES.map((name, i) => [name, uuid(100 + i)])) as Record<(typeof NAMES)[number], string>;

/**
 * One consistent world for one operation: five people, a collection everyone reads and writes (`open`: the member writes, the viewer reads), one that only an
 * administrator reads (`closed`), a live page and a deleted page in each, a revision, a group with a member, and an access entry. Every walk starts from a
 * fresh world, because the operations that succeed change it.
 */
export async function buildWorld() {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = {
    verify: (token) => Promise.resolve(NAMES.includes(token as never) ? { kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 } : { kind: 'invalid-token' }),
  };
  const rows: UserRecord[] = NAMES.map((name) => ({
    id: USER_ID[name], descopeUserId: `d-${name}`, email: name === 'former' ? 'former@gone.example.org' : `${name}@example.com`, name, role: ROLE[name], suspended: name === 'suspended',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: r.suspended });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const page = pages.seed({ collectionId: open.id, title: 'Open page', markdown: 'text' });
  const hidden = pages.seed({ collectionId: closed.id, title: 'Closed page', markdown: 'secret' });
  const trash = new FakeTrashRepo(world);
  // The delete route works on the trash repository's own pages: the live page is there too, under the same id.
  trash.seedLive({ id: page.id, collectionId: open.id, title: 'Open page' });
  const trashed = trash.seedDeleted({ collectionId: open.id, title: 'Open deleted' });
  const hiddenTrashed = trash.seedDeleted({ collectionId: closed.id, title: 'Closed deleted' });
  const revisions = new FakeRevisionRepo();
  const revision = revisions.seed({ pageId: page.id, createdAt: 10_000, title: 'T', markdown: 'M' });
  const pageState = new FakePageStateRepo();
  pageState.track(page.id, { markdown: 'text' });
  pageState.track(hidden.id, { markdown: 'secret' });
  const adminRows: AdminUser[] = rows.map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, suspended: r.suspended }));
  const admin = new FakeAdminRepo(adminRows);
  const made = await admin.createGroup('Writers', USER_ID.admin);
  if (made.kind !== 'saved') throw new Error('group');
  await admin.addMember(made.group.id, USER_ID.member, USER_ID.admin);
  const granted = await collections.upsertAccess(open.id, { principalType: 'user', principalId: USER_ID.member, permission: 'read_write' }, USER_ID.admin);
  if (granted.kind !== 'saved') throw new Error('access entry');
  const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown: 'canonical', text: 'canonical' } });
  // Limits that the walk cannot reach: it sends a handful of requests per credential, not a flood.
  const config = makeFakeConfig({ allowedEmailDomains: ['example.com'], http: { userLimitPerMinute: 100_000, addressLimitPerMinute: 100_000, addressCeilingPerMinute: 100_000 } });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, collections, pages, trash, revisions, pageState, admin, converter, audit: collections.audit,
      idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: Who | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** Takes away a person's right to write (a viewer cannot), in the store the sign-in step reads and in the one the access decisions read. */
  const demote = async (who: (typeof NAMES)[number], role: Role = 'viewer'): Promise<void> => {
    await users.updateRole(USER_ID[who], role);
    const fact = world.users.find((u) => u.id === USER_ID[who]);
    if (fact !== undefined) fact.role = role;
  };
  /** Suspends a person in the store the sign-in step reads and in the one the access decisions read. */
  const suspend = (who: (typeof NAMES)[number]): void => {
    users.suspend(`d-${who}`);
    const fact = world.users.find((u) => u.id === USER_ID[who]);
    if (fact !== undefined) fact.suspended = true;
  };
  const ids = {
    openCollection: open.id, closedCollection: closed.id, page: page.id, hiddenPage: hidden.id, urlId: page.urlId, hiddenUrlId: hidden.urlId,
    trashed, hiddenTrashed, revision: revision.id, group: made.group.id, entry: granted.entry.id,
  };
  return { call, demote, suspend, ids, world, pages, collections, converter, trash, pageState, admin, config };
}
export type WorldBuilt = Awaited<ReturnType<typeof buildWorld>>;

/** The path of an operation filled in with ids of this world: `hidden` points it at the resource that only an administrator can read. */
export function pathFor(op: Operation, w: WorldBuilt, hidden = false): string {
  const i = w.ids;
  const resource = (): string => {
    if (op.path.startsWith('/v1/collections')) return hidden ? i.closedCollection : i.openCollection;
    if (op.path.startsWith('/v1/trash')) return hidden ? i.hiddenTrashed : i.trashed;
    if (op.path.startsWith('/v1/pages')) return hidden ? i.hiddenPage : i.page;
    if (op.path.startsWith('/v1/groups')) return i.group;
    return USER_ID.member; // /v1/users/{id}
  };
  return op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    switch (name) {
      case 'id': return resource();
      case 'urlId': return hidden ? i.hiddenUrlId : i.urlId;
      case 'rid': return i.revision;
      case 'entryId': return i.entry;
      case 'userId': return USER_ID.member;
      default: throw new Error(`no value for the path parameter ${name} of ${op.key}`);
    }
  });
}

/** Ids a generated body may name: the collection the walk writes into, and a user. */
export function bodyHints(w: WorldBuilt, hidden = false): Record<string, unknown> {
  return { uuid: NIL, collectionId: hidden ? w.ids.closedCollection : w.ids.openCollection, principalId: USER_ID.member, userId: USER_ID.member, ids: [USER_ID.member], parentId: null };
}
