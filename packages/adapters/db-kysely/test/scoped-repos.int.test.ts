import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { NO_IMPORT_COUNTS } from '@tektum/grimoire-core/ports/import-repo';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { TenantPageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAdmin } from '../src/admin.js';
import { createAudit } from '../src/audit.js';
import { createCollections } from '../src/collections.js';
import { createEmbeddingStore } from '../src/embeddings.js';
import { createIdempotency } from '../src/idempotency.js';
import { createImportRepo } from '../src/imports.js';
import { createPageStore } from '../src/page-store.js';
import { createPageState } from '../src/page-state.js';
import { createPages } from '../src/pages.js';
import { createRevisions } from '../src/revisions.js';
import { createSearchRepo } from '../src/search.js';
import { createTenants } from '../src/tenants.js';
import { createTrash } from '../src/trash.js';
import { createUserStore } from '../src/users.js';
import { addGroup, addTenant, addUser, createTestDatabase } from './collections/support.js';
import type { TestDatabase } from './collections/support.js';

// docs/tenancy.md section 3.2, step 2: every method of a tenant-scoped repository that takes a tenant runs each of its statements through `scoped(db, tenant)`, so that
// once the row-level security policies are on (step 4) none of them sees no rows. Every statement any connection sends is recorded; a statement counts as scoped when
// the transaction it runs in began with `begin; set local app.tenant = '<the tenant passed>'`. Step 3: a method that must cross tenants runs every statement in a
// transaction of the operator role, `grimoire_ops`.
const TENANT = 'T-guard';
const BEGIN = /^begin; set local app\.tenant = '([^']*)'$/;

const sent: { client: pg.Client; sql: string }[] = [];
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function record(this: pg.Client, ...args: unknown[]) {
  if (typeof args[0] === 'string') sent.push({ client: this, sql: args[0] });
  return (query as (...a: unknown[]) => unknown).apply(this, args);
} as typeof query;

/** The statements of `sent` from `from` on that did not run in a transaction scoped to `tenant`; `ran` counts the others. */
function unscoped(from: number, tenant: string): { ran: number; outside: string[] } {
  const scope = new Map<pg.Client, string | undefined>();
  const outside: string[] = [];
  let ran = 0;
  for (const { client, sql } of sent.slice(from)) {
    const begin = BEGIN.exec(sql);
    if (begin !== null) scope.set(client, begin[1]);
    else if (sql === 'begin') scope.set(client, undefined);
    else if (sql === 'commit' || sql === 'rollback') scope.delete(client);
    else if (scope.get(client) === tenant) ran += 1;
    else outside.push(sql.replace(/\s+/g, ' ').slice(0, 120));
  }
  return { ran, outside };
}

/** The statements of `sent` from `from` on that did not run in a transaction of the operator role; `ran` counts the others. */
function offOperator(from: number): { ran: number; outside: string[] } {
  const open = new Set<pg.Client>();
  const outside: string[] = [];
  let ran = 0;
  for (const { client, sql } of sent.slice(from)) {
    if (sql === 'begin') open.add(client);
    else if (sql === 'commit' || sql === 'rollback') open.delete(client);
    else if (open.has(client) && client.user === 'grimoire_ops') ran += 1;
    else outside.push(sql.replace(/\s+/g, ' ').slice(0, 120));
  }
  return { ran, outside };
}

const ordering = new FakeOrdering();
const place = (before: string | null, after: string | null) => ordering.between(before, after);
const last = (l: string | null) => ordering.between(l, null);
const limits: TenantPageLimits = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
let t: TestDatabase;
let s: { boss: string; member: string; group: string; collection: string; other: string; page: string; urlId: string; child: string; revision: string; entry?: string; made?: string; batch?: string | undefined; importId: string; item?: string | undefined; skipped?: string | undefined; hash?: Uint8Array | undefined };

beforeAll(async () => {
  t = await createTestDatabase('scopedrepos');
  await addTenant(t.app, TENANT);
  const boss = await addUser(t.app, 'guard-boss', 'admin', TENANT);
  const member = await addUser(t.app, 'guard-member', 'member', TENANT);
  const group = await addGroup(t.app, 'guards', TENANT);
  const collections = createCollections(t.app);
  const collection = (await collections.append(TENANT, { name: 'Docs', createdBy: boss }, last)).id;
  const other = (await collections.append(TENANT, { name: 'Other', createdBy: boss }, last)).id;
  const seeded = await seedUserMarkdown(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1]) }, convert: { ok: true, markdown: '# a', text: 'a' } }), boss, 'A', '# a');
  if (isSeedRefusal(seeded)) throw new Error('refused');
  const make = async (collectionId: string, parentId: string | null, title: string) => {
    const r = await createPages(t.app).create(TENANT, { collectionId, parentId, afterId: null, title, createdBy: boss, content: seeded }, limits, place);
    if (r.kind !== 'created') throw new Error(r.kind);
    return r.page;
  };
  const page = await make(collection, null, 'A');
  const child = (await make(collection, null, 'B')).id;
  await make(other, null, 'C');
  const revision = await createRevisions(t.app, t.ops).createFromPage({ pageId: page.id, reason: 'idle', authorIds: [boss], lastAuthorId: boss, at: Date.now() });
  if (revision.kind !== 'created') throw new Error(revision.kind);
  s = { boss, member, group, collection, other, page: page.id, urlId: page.urlId, child, revision: revision.id, importId: randomUUID() };
}, 120_000);
afterAll(async () => {
  pg.Client.prototype.query = query;
  await t?.drop();
});

// Each call runs against the rows above, in this order (later calls use what earlier ones made), and reaches the statements of its main path.
const admin = () => createAdmin(t.app);
const collections = () => createCollections(t.app);
const pages = () => createPages(t.app);
const trash = () => createTrash(t.app);
const revisions = () => createRevisions(t.app, t.ops);
const users = () => createUserStore(t.app, t.ops, 100);
const idempotency = () => createIdempotency(t.app, t.ops);
const audit = () => createAudit(t.app, t.ops);
const tenants = () => createTenants(t.ops);
const pageStore = () => createPageStore(t.app, t.ops, { now: () => Date.now() });
const embeddings = () => createEmbeddingStore(t.app, t.ops);
const vector = Float32Array.from([1, 0, 0]);
const pageState = () => createPageState(t.app);
const imports = () => createImportRepo(t.app);
const search = () => createSearchRepo(t.app, { statementTimeoutMs: 5000 });
const calls: Record<string, Record<string, (tenant: string) => Promise<unknown>>> = {
  admin: {
    listUsers: (tn) => admin().listUsers(tn, { q: 'guard', limit: 10, after: ['a@example.com', s.boss] }),
    patchUser: (tn) => admin().patchUser(tn, s.member, { role: 'viewer' }, s.boss),
    userNames: (tn) => admin().userNames(tn, [s.member]),
    listGroups: (tn) => admin().listGroups(tn),
    createGroup: async (tn) => { const r = await admin().createGroup(tn, 'made', s.boss); if (r.kind === 'saved') s.made = r.group.id; },
    renameGroup: (tn) => admin().renameGroup(tn, s.made ?? '', 'renamed', s.boss),
    addMember: (tn) => admin().addMember(tn, s.group, s.member, s.boss),
    listMembers: (tn) => admin().listMembers(tn, s.group),
    removeMember: (tn) => admin().removeMember(tn, s.group, s.member, s.boss),
    deleteGroup: (tn) => admin().deleteGroup(tn, s.made ?? '', s.boss),
  },
  collections: {
    listLive: (tn) => collections().listLive(tn, [s.collection]),
    get: (tn) => collections().get(tn, s.collection),
    append: (tn) => collections().append(tn, { name: 'More', createdBy: s.boss }, last),
    update: (tn) => collections().update(tn, s.collection, { name: 'Docs 2' }, s.boss),
    upsertAccess: async (tn) => { const r = await collections().upsertAccess(tn, s.collection, { principalType: 'user', principalId: s.member, permission: 'read' }, s.boss); if (r.kind === 'saved') s.entry = r.entry.id; },
    listAccess: (tn) => collections().listAccess(tn, s.collection),
    removeAccess: (tn) => collections().removeAccess(tn, s.collection, s.entry ?? '', s.boss),
    tree: (tn) => collections().tree(tn, s.collection),
    softDelete: async (tn) => { s.batch = (await collections().softDelete(tn, s.other, s.boss))?.batch; },
  },
  pages: {
    create: (tn) => pages().create(tn, { collectionId: s.collection, parentId: s.page, afterId: null, title: 'New', createdBy: s.boss }, limits, place),
    get: (tn) => pages().get(tn, s.page),
    markdownOf: (tn) => pages().markdownOf(tn, s.page),
    idOfUrlId: (tn) => pages().idOfUrlId(tn, s.urlId),
    updateMeta: (tn) => pages().updateMeta(tn, s.page, { title: 'A 2' }),
    move: (tn) => pages().move(tn, s.child, { expectedCollectionId: s.collection, collectionId: null, parentId: s.page, afterId: null }, limits, place),
    softDelete: (tn) => pages().softDelete(tn, s.child, s.boss, s.collection),
  },
  revisions: {
    list: async (tn) => [await revisions().list(tn, s.page, { limit: 10 }), await revisions().list(tn, s.page, { limit: 10, after: [Date.now() * 1000, s.revision] })],
    get: (tn) => revisions().get(tn, s.page, s.revision),
    snapshotBeforeRestore: (tn) => revisions().snapshotBeforeRestore(tn, s.page),
  },
  pageState: {
    reset: (tn) => pageState().reset({ tenantId: tn, pageId: s.page, actorId: s.boss, confirmStale: true }),
  },
  trash: {
    roots: (tn) => trash().roots(tn, null, 10, { deletedAt: Date.now() + 60_000, id: s.page }),
    rootOf: (tn) => trash().rootOf(tn, s.child),
    restore: (tn) => trash().restore(tn, s.child, s.collection, limits, place),
    attachmentKeys: (tn) => trash().attachmentKeys(tn, s.batch ?? ''),
    markFilesRemoved: (tn) => trash().markFilesRemoved(tn, ['tenants/T-guard/attachments/none']),
    purge: (tn) => trash().purge(tn, s.batch ?? '', s.boss, []),
    expiredBatches: (tn) => trash().expiredBatches(tn, Date.now(), 10),
  },
  users: {
    updateRole: (tn) => users().updateRole(tn, s.member, 'member'),
  },
  idempotency: {
    claim: (tn) => idempotency().claim(tn, s.boss, 'guard-key', 'ab'),
    complete: (tn) => idempotency().complete(tn, s.boss, 'guard-key', { status: 200, body: null }),
    release: (tn) => idempotency().release(tn, s.boss, 'guard-key'),
  },
  audit: {
    append: (tn) => audit().append({ actorId: s.boss, action: 'guard.checked', targetType: 'page', targetId: s.page, tenantId: tn }),
  },
  embeddings: {
    pageText: async (tn) => { s.hash = (await embeddings().pageText(tn, s.page))?.markdownHash; },
    existingHashes: (tn) => embeddings().existingHashes(tn, s.page, 'guard'),
    replacePage: (tn) => embeddings().replacePage(tn, s.page, s.hash ?? new Uint8Array(), 'guard', [{ chunkIndex: 0, contentHash: new Uint8Array(32), charStart: 0, charEnd: 1, tokenCount: 1, embedding: vector }]),
    markFailed: (tn) => embeddings().markFailed(tn, s.page, s.hash ?? new Uint8Array(), 'guard', 'x'),
    pagesNeedingEmbedding: (tn) => embeddings().pagesNeedingEmbedding(tn, 'guard', { olderThanSeconds: 0, limit: 10 }),
    search: (tn) => embeddings().search(tn, vector, { model: 'guard', collectionIds: [s.collection], limit: 10, minSimilarity: 0 }),
  },
  imports: {
    create: (tn) => imports().create(tn, { id: s.importId, targetCollectionId: s.collection, createdBy: s.boss, source: 'markdown_zip', bytes: 1, s3Key: `tenants/${tn}/imports/${s.importId}` }),
    markUploaded: (tn) => imports().markUploaded(tn, s.importId),
    start: (tn) => imports().start(tn, s.importId, Date.now()),
    addItems: (tn) => imports().addItems(tn, s.importId, [{ path: 'a.md', kind: 'page' }, { path: 'b.md', kind: 'page' }]),
    pending: async (tn) => { const items = await imports().pending(tn, s.importId, 'page', 10); s.item = items[0]?.id; s.skipped = items[1]?.id; },
    getItem: (tn) => imports().getItem(tn, s.importId, s.item ?? '0'),
    scanItems: (tn) => imports().scanItems(tn, s.importId, { limit: 10 }),
    settle: (tn) => imports().settle(tn, s.importId, s.skipped ?? '0', { status: 'skipped', message: 'guard' }),
    listItems: (tn) => imports().listItems(tn, s.importId, { limit: 10 }),
    writePage: (tn) => imports().writePage(tn, s.importId, { itemId: s.item ?? '0', collectionId: s.collection, parentId: null, position: place, title: 'Imported', createdBy: s.boss, content: { state: new Uint8Array([1]), markdown: '# i', text: 'i', hash: Buffer.alloc(32) }, markdownBytes: 3, stateBytes: 1, attachments: [] }, limits, Date.now()),
    setCounts: (tn) => imports().setCounts(tn, s.importId, NO_IMPORT_COUNTS),
    finish: (tn) => imports().finish(tn, s.importId, 'done', null, Date.now()),
    cancel: (tn) => imports().cancel(tn, s.importId, Date.now()),
    get: (tn) => imports().get(tn, s.importId),
  },
  search: {
    search: (tn) => search().search({ tenantId: tn, collectionIds: [s.collection], query: 'imported', limit: 10 }),
  },
};
// The methods that cross tenants, on the operator connection (docs/tenancy.md section 3.2): each runs every statement in an operator transaction.
const operatorCalls: Record<string, Record<string, () => Promise<unknown>>> = {
  users: {
    findByDescopeId: () => users().findByDescopeId('guard-boss'),
    createIfAbsent: () => users().createIfAbsent({ descopeUserId: 'guard-new', email: 'guard-new@example.com', name: 'New', role: 'member', tenant: { id: TENANT, name: 'example.com' } }),
  },
  idempotency: { deleteCreatedBefore: () => idempotency().deleteCreatedBefore(0) },
  audit: { append: () => audit().append({ actorId: s.boss, action: 'guard.checked', targetType: 'page', targetId: s.page }) },
  tenants: { ids: () => tenants().ids() },
  revisions: { catchUp: () => revisions().catchUp(Date.now(), 10) },
  pageStore: { listStale: () => pageStore().listStale(10) },
  embeddings: { counts: () => embeddings().counts('guard') },
};
// The methods not moved yet: step 3 scopes them by a tenant their callers know, or gives them to the operator connection.
const crossTenant: Record<string, readonly string[]> = {
  revisions: ['createFromPage'], pageStore: ['load', 'seed', 'store', 'repairMarkdown'],
};

describe('the tenant-scoped repositories', () => {
  it('list every method here, as scoped, on the operator connection, or as crossing tenants', () => {
    const repos = { admin: admin(), collections: collections(), pages: pages(), revisions: revisions(), pageState: pageState(), trash: trash(), users: users(), idempotency: idempotency(), audit: audit(), tenants: tenants(), pageStore: pageStore(), embeddings: embeddings(), imports: imports(), search: search() };
    for (const [name, repo] of Object.entries(repos)) {
      const listed = new Set([...Object.keys(calls[name] ?? {}), ...Object.keys(operatorCalls[name] ?? {}), ...(crossTenant[name] ?? [])]);
      expect(Object.keys(repo).sort(), name).toEqual([...listed].sort());
    }
  });

  for (const [repo, methods] of Object.entries(calls)) {
    for (const [method, call] of Object.entries(methods)) {
      it(`${repo}.${method} runs every statement scoped to the tenant it is given`, async () => {
        const from = sent.length;
        await call(TENANT);
        const { ran, outside } = unscoped(from, TENANT);
        expect(outside).toEqual([]);
        expect(ran).toBeGreaterThan(0);
      });
    }
  }

  for (const [repo, methods] of Object.entries(operatorCalls)) {
    for (const [method, call] of Object.entries(methods)) {
      it(`${repo}.${method} runs every statement in a transaction of the operator role`, async () => {
        const from = sent.length;
        await call();
        const { ran, outside } = offOperator(from);
        expect(outside).toEqual([]);
        expect(ran).toBeGreaterThan(0);
      });
    }
  }
});
