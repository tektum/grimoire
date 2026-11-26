import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AdminUser } from '@tektum/grimoire-core/ports/admin-repo';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAdminRepo } from '@tektum/grimoire-core/testing/fake-admin-repo';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
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
import { importFailedKey, importZipKey } from '../../src/import/keys.js';
import { buildZip } from '../import/hostile/zip-builder.js';
import type { Operation } from './document.js';

/** Who the walk signs in as. The token is the name; `garbage` and `expired` are tokens the verifier refuses. */
export type Who = 'admin' | 'member' | 'viewer' | 'suspended' | 'former' | 'outsider' | 'garbage' | 'expired';

const NAMES = ['admin', 'member', 'viewer', 'suspended', 'former'] as const;
const ROLE: Record<(typeof NAMES)[number], Role> = { admin: 'admin', member: 'member', viewer: 'viewer', suspended: 'member', former: 'member' };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const NIL = uuid(0);
/** The administrator of another tenant (`other`), present when a world is built with `outsider`: every id of this world belongs to `legacy`, so none of them exists for this person. */
export const OUTSIDER_ID = uuid(199);
export const USER_ID = Object.fromEntries(NAMES.map((name, i) => [name, uuid(100 + i)])) as Record<(typeof NAMES)[number], string>;

/**
 * One consistent world for one operation: five people, a collection everyone reads and writes (`open`: the member writes, the viewer reads), one that only an
 * administrator reads (`closed`), a live page and a deleted page in each, a revision, a group with a member, and an access entry. Every walk starts from a
 * fresh world, because the operations that succeed change it.
 */
const FILES = {
  endpoint: 'http://s3.invalid', publicEndpoint: 'http://s3.invalid', publicOrigin: 'http://s3.invalid', bucket: 'b', accessKey: 'a', secretKey: 's', region: 'r',
  addressing: 'path' as const, createOnlyHeader: 'if-none-match' as const, corsMode: 'external' as const, maxBytes: 1000, allowedTypes: ['image/png'], pendingMaxPerUser: 100,
};
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

export async function buildWorld(options: { outsider?: boolean } = {}) {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = {
    verify: (token) => Promise.resolve(NAMES.includes(token as never) || (options.outsider === true && token === 'outsider') ? { kind: 'ok', userId: `d-${token}`, expiresAt: 9e12, ...(token === 'outsider' ? { tenant: { kind: 'one' as const, id: 'other' } } : {}) } : { kind: 'invalid-token' }),
  };
  const rows: UserRecord[] = NAMES.map((name) => ({
    id: USER_ID[name], descopeUserId: `d-${name}`, email: name === 'former' ? 'former@gone.example.org' : `${name}@example.com`, name, role: ROLE[name], suspended: name === 'suspended', tenantId: 'legacy',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: r.suspended });
  if (options.outsider === true) {
    rows.push({ id: OUTSIDER_ID, descopeUserId: 'd-outsider', email: 'outsider@example.com', name: 'outsider', role: 'admin', suspended: false, tenantId: 'other' });
    world.users.push({ id: OUTSIDER_ID, role: 'admin', suspended: false, tenantId: 'other' });
  }
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
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
  // What the restore route copies before it answers: the saved text of the page.
  revisions.setPage(page.id, { title: 'Open page', markdown: 'text' });
  const pageState = new FakePageStateRepo();
  pageState.track(page.id, { markdown: 'text' });
  pageState.track(hidden.id, { markdown: 'secret' });
  const adminRows: AdminUser[] = rows.map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, suspended: r.suspended }));
  const admin = new FakeAdminRepo(adminRows);
  const made = await admin.createGroup('legacy', 'Writers', USER_ID.admin);
  if (made.kind !== 'saved') throw new Error('group');
  await admin.addMember('legacy', made.group.id, USER_ID.member, USER_ID.admin);
  const granted = await collections.upsertAccess('legacy', open.id, { principalType: 'user', principalId: USER_ID.member, permission: 'read_write' }, USER_ID.admin);
  if (granted.kind !== 'saved') throw new Error('access entry');
  const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown: 'canonical', text: 'canonical' } });
  // Limits that the walk cannot reach: it sends a handful of requests per credential, not a flood.
  // Four attachments by the member: ready and pending, on the open page and on the one only an administrator reads. Each has its object.
  const attachments = new FakeAttachmentRepo();
  const files = new FakeFileStorage({ clock: t.clock });
  const attachment = (n: number, pageId: string, status: 'ready' | 'pending'): string => {
    const id = uuid(900 + n);
    attachments.seed({ id, pageId, uploaderId: USER_ID.member, fileName: 'a.png', contentType: 'image/png', size: PNG_BYTES.length, tenantId: 'legacy', key: `attachments/${id}`, status, expiresAt: status === 'pending' ? t.clock.now() + 3_600_000 : null, createdAt: t.clock.now(), readyAt: status === 'ready' ? t.clock.now() : null });
    return id;
  };
  const readyAttachment = attachment(1, page.id, 'ready');
  const hiddenReadyAttachment = attachment(2, hidden.id, 'ready');
  const pendingAttachment = attachment(3, page.id, 'pending');
  const hiddenPendingAttachment = attachment(4, hidden.id, 'pending');
  for (const id of [readyAttachment, hiddenReadyAttachment, pendingAttachment, hiddenPendingAttachment]) await files.put(`attachments/${id}`, PNG_BYTES, { size: PNG_BYTES.length, contentType: 'image/png' });
  // Two imports in the same workspace: one by the member and one by the administrator (the one a member cannot see). Each has its zip, and a failed page with its kept original.
  const imports = new FakeImportRepo();
  const importOf = (n: number): string => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`;
  const importRows = { import: importOf(1), hiddenImport: importOf(2) };
  const ZIP_BYTES = buildZip([{ name: 'a.md', data: Buffer.from('# a\n') }]);
  const items: Record<string, string> = {};
  const seedImport = async (id: string, who: 'member' | 'admin', status: 'created' | 'running' | 'done'): Promise<void> => {
    imports.seed({ id, tenantId: 'legacy', status, createdBy: USER_ID[who], targetCollectionId: open.id, bytes: ZIP_BYTES.length, s3Key: importZipKey('legacy', id) });
    await files.put(importZipKey('legacy', id), ZIP_BYTES, { size: ZIP_BYTES.length, contentType: 'application/zip' });
  };
  await seedImport(importRows.import, 'member', 'done');
  await seedImport(importRows.hiddenImport, 'admin', 'done');
  for (const id of [importRows.import, importRows.hiddenImport]) {
    await imports.addItems('legacy', id, [{ path: 'notes/broken.md', kind: 'page' }]);
    const [pending] = await imports.pending('legacy', id, 'page', 1);
    await imports.settle('legacy', id, pending!.id, { status: 'failed', message: 'content-lost' });
    await files.put(importFailedKey('legacy', id, pending!.id), new Uint8Array([35, 32]), { size: 2, contentType: 'text/markdown' });
    items[id] = pending!.id;
  }
  /** The state an import must be in for an operation to be able to succeed: a start needs one that waits (and no other running), a cancel one that runs, the rest one that has ended. */
  const prepareImport = async (op: Operation, hidden: boolean): Promise<void> => {
    if (!op.path.startsWith('/v1/imports/')) return;
    const id = hidden ? importRows.hiddenImport : importRows.import;
    const status = op.path.endsWith('/start') ? 'created' : op.path.endsWith('/cancel') ? 'running' : 'done';
    const row = await imports.get('legacy', id);
    imports.seed({ ...(row as NonNullable<typeof row>), status });
  };
  const config = makeFakeConfig({ files: FILES, allowedEmailDomains: ['example.com'], http: { userLimitPerMinute: 100_000, addressLimitPerMinute: 100_000, addressCeilingPerMinute: 100_000 } });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, collections, pages, trash, revisions, pageState, admin, converter, audit: collections.audit, attachments, files, imports,
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
    await users.updateRole('legacy', USER_ID[who], role);
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
    ...importRows, item: items[importRows.import] as string, hiddenItem: items[importRows.hiddenImport] as string, readyAttachment, hiddenReadyAttachment, pendingAttachment, hiddenPendingAttachment, trashed, hiddenTrashed, revision: revision.id, group: made.group.id, entry: granted.entry.id,
  };
  return { call, demote, suspend, prepareImport, imports, ids, world, pages, collections, converter, trash, pageState, admin, config };
}
export type WorldBuilt = Awaited<ReturnType<typeof buildWorld>>;

/** The path of an operation filled in with ids of this world: `hidden` points it at the resource that only an administrator can read. */
/** An example value for each query parameter an operation requires (a search needs its `q`): a request without one is 422, which hides what the policy does. */
function requiredQuery(op: Operation): string {
  const required = (op.raw.parameters ?? []).filter((p) => p.in === 'query' && p.required === true);
  return required.length === 0 ? '' : `?${required.map((p) => `${p.name}=${p.schema?.type === 'integer' ? '1' : 'plan'}`).join('&')}`;
}

export function pathFor(op: Operation, w: WorldBuilt, hidden = false): string {
  return `${pathWithoutQuery(op, w, hidden)}${requiredQuery(op)}`;
}

function pathWithoutQuery(op: Operation, w: WorldBuilt, hidden: boolean): string {
  const i = w.ids;
  const resource = (): string => {
    if (op.path.startsWith('/v1/collections')) return hidden ? i.closedCollection : i.openCollection;
    if (op.path.startsWith('/v1/trash')) return hidden ? i.hiddenTrashed : i.trashed;
    if (op.path.startsWith('/v1/pages')) return hidden ? i.hiddenPage : i.page;
    if (op.path.startsWith('/v1/attachments')) return op.path.endsWith('/complete') ? (hidden ? i.hiddenPendingAttachment : i.pendingAttachment) : (hidden ? i.hiddenReadyAttachment : i.readyAttachment);
    if (op.path.startsWith('/v1/imports')) return hidden ? i.hiddenImport : i.import;
    if (op.path.startsWith('/v1/groups')) return i.group;
    return USER_ID.member; // /v1/users/{id}
  };
  return op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    switch (name) {
      case 'id': return resource();
      case 'urlId': return hidden ? i.hiddenUrlId : i.urlId;
      case 'rid': return i.revision;
      case 'itemId': return hidden ? i.hiddenItem : i.item;
      case 'entryId': return i.entry;
      case 'userId': return USER_ID.member;
      default: throw new Error(`no value for the path parameter ${name} of ${op.key}`);
    }
  });
}

/** Ids a generated body may name: the collection the walk writes into, and a user. */
export function bodyHints(w: WorldBuilt, hidden = false): Record<string, unknown> {
  return { uuid: NIL, pageId: hidden ? w.ids.hiddenPage : w.ids.page, fileName: 'a.png', contentType: 'image/png', size: 16, collectionId: hidden ? w.ids.closedCollection : w.ids.openCollection, principalId: USER_ID.member, userId: USER_ID.member, ids: [USER_ID.member], parentId: null };
}
