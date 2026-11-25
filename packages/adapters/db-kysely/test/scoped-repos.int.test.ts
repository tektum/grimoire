import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { TenantPageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAdmin } from '../src/admin.js';
import { createCollections } from '../src/collections.js';
import { createPages } from '../src/pages.js';
import { createRevisions } from '../src/revisions.js';
import { createTrash } from '../src/trash.js';
import { addGroup, addTenant, addUser, createTestDatabase } from './collections/support.js';
import type { TestDatabase } from './collections/support.js';

// docs/tenancy.md section 3.2, step 2: every method of a tenant-scoped repository that takes a tenant runs each of its statements through `scoped(db, tenant)`, so that
// once the row-level security policies are on (step 4) none of them sees no rows. Every statement any connection sends is recorded; a statement counts as scoped when
// the transaction it runs in began with `begin; set local app.tenant = '<the tenant passed>'`.
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

const ordering = new FakeOrdering();
const place = (before: string | null, after: string | null) => ordering.between(before, after);
const last = (l: string | null) => ordering.between(l, null);
const limits: TenantPageLimits = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
let t: TestDatabase;
let s: { boss: string; member: string; group: string; collection: string; other: string; page: string; urlId: string; child: string; revision: string; entry?: string; made?: string; batch?: string | undefined };

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
  const revision = await createRevisions(t.app).createFromPage({ pageId: page.id, reason: 'idle', authorIds: [boss], lastAuthorId: boss, at: Date.now() });
  if (revision.kind !== 'created') throw new Error(revision.kind);
  s = { boss, member, group, collection, other, page: page.id, urlId: page.urlId, child, revision: revision.id };
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
const revisions = () => createRevisions(t.app);
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
  },
  trash: {
    roots: (tn) => trash().roots(tn, null, 10, { deletedAt: Date.now() + 60_000, id: s.page }),
    rootOf: (tn) => trash().rootOf(tn, s.child),
    restore: (tn) => trash().restore(tn, s.child, s.collection, limits, place),
    purge: (tn) => trash().purge(tn, s.batch ?? '', s.boss, []),
    expiredBatches: (tn) => trash().expiredBatches(tn, Date.now(), 10),
  },
};
// The methods with no tenant to scope by: the operator connection of step 3 takes them (docs/tenancy.md section 3.2).
const crossTenant: Record<string, readonly string[]> = { admin: [], collections: [], pages: [], revisions: ['createFromPage', 'catchUp', 'snapshotBeforeRestore'], trash: ['attachmentKeys', 'markFilesRemoved'] };

describe('the tenant-scoped repositories', () => {
  it('list every method here, as scoped or as crossing tenants', () => {
    for (const [name, repo] of Object.entries({ admin: admin(), collections: collections(), pages: pages(), revisions: revisions(), trash: trash() })) {
      expect(Object.keys(repo).sort(), name).toEqual([...Object.keys(calls[name] ?? {}), ...(crossTenant[name] ?? [])].sort());
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
});
