import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessStore, createDatabase, createEmbeddingStore, createOpsDatabase, createSearchRepo, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase, OperatorDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Embedder, EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { insertCollection, insertPage, insertUser, opsUrl, raw } from '@tektum/grimoire-test-support/database';
import { createApp } from '../../src/app.js';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';
import { makeContext } from '../server/support/context.js';

// M7-T07, the search permission suite under the tenant model (docs/tenancy.md section 7, test 4): two tenants, three collections in the first. A word that exists only on a page the asker may not read
// (an unreadable collection, an administrator-only collection, the trash, or the other tenant) is never found: not in an item, a snippet or a cursor, for 20 generated queries, and the same with the
// semantic list on, where the other tenant's chunk IS the query vector (the best possible match).
const DB = 'grimoire_m7t07_search';
const A = 'tenant-a';
const B = 'tenant-b';
const DIMS = 4;
const QUERY = Float32Array.from([1, 0, 0, 0]);
const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const run = (sql: string) => sqlAdmin(DB, sql);

const embedder: Embedder = {
  model: { name: 'fake-e5', version: 'v1', dims: DIMS, maxTokens: 64 },
  status: () => 'ready',
  countTokens: (text) => text.split(/\s+/).length,
  embedPassages: () => Promise.resolve<EmbedResult>({ ok: false, reason: 'unavailable' }),
  embedQuery: () => Promise.resolve<EmbedResult>({ ok: true, vectors: [QUERY] }),
  stats: () => ({ threads: 1, queued: 0, chunksPerMinute: 0 }),
  close: () => Promise.resolve(),
};

type Kind = 'restricted' | 'admin-only' | 'trashed' | 'other-tenant';
const KINDS: readonly Kind[] = ['restricted', 'admin-only', 'trashed', 'other-tenant'];
/** Twenty words, each only on one unreadable page (the kind rotates), the same in every run. */
const TERMS = Array.from({ length: 20 }, (_, i) => ({ term: `zq${String(i)}marker`, kind: KINDS[i % KINDS.length] as Kind }));
const PEOPLE = 24; // `/v1/search` allows 30 requests a minute to one person, and a case follows its cursors: each case is a person of its own

let db: KyselyDatabase;
let ops: OperatorDatabase;
let store: EmbeddingStore;
let app: ReturnType<typeof appOver>;
const cols = { open: '', restricted: '', adminOnly: '', other: '' };
const pageOf = new Map<string, string>();

function appOver() {
  const t = makeContext();
  const config = makeFakeConfig({ allowedEmailDomains: ['example.com'] });
  // A token names its tenant: `b-...` is the second tenant's, anything else the first's.
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12, tenant: { kind: 'one', id: token.startsWith('b-') ? B : A } }) };
  const users = createUserStore(db, ops, 1000);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const access = createAccessStore(db);
  const hybrid: SemanticSearch = { embedder, store, settings: { enabled: true, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 } };
  return createApp({
    ...t.ctx,
    config,
    auth: { verifier },
    signInPolicy,
    http: {
      ...t.ctx.http,
      config,
      users,
      access: createPageAccess(access),
      authorizer: createAuthorizer(access),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      search: createSearchRepo(db, { statementTimeoutMs: 5000 }),
      hybrid,
    },
  });
}

const get = (path: string, who: string) => app.request(path, { headers: { authorization: `Bearer ${who}` } });

async function page(tenant: string, collection: string, title: string, text: string, over: Record<string, unknown> = {}): Promise<string> {
  return insertPage(run, { tenant_id: tenant, collection_id: collection, title, text_content: text, markdown_hash: raw(`decode('${hex(1)}', 'hex')`), ...over });
}

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  db = createDatabase(appUrl(DB));
  ops = createOpsDatabase(opsUrl(DB));
  store = createEmbeddingStore(db, ops);
  await run(`insert into tenants (id, name) values ('${A}', 'A'), ('${B}', 'B')`);
  for (let i = 0; i < PEOPLE; i += 1) await insertUser(run, { tenant_id: A, descope_user_id: `d-a-m${String(i)}`, email: `a-m${String(i)}@example.com`, role: 'member' });
  await insertUser(run, { tenant_id: A, descope_user_id: 'd-a-admin', email: 'a-admin@example.com', role: 'admin' });
  const other = await insertUser(run, { tenant_id: A, descope_user_id: 'd-a-other', email: 'a-other@example.com', role: 'member' });
  await insertUser(run, { tenant_id: B, descope_user_id: 'd-b-m0', email: 'b-m0@example.com', role: 'member' });
  cols.open = await insertCollection(run, { tenant_id: A, default_permission: 'read' });
  cols.restricted = await insertCollection(run, { tenant_id: A }); // a grant to one other member only
  await run(`insert into collection_access (tenant_id, collection_id, user_id, permission) values ('${A}', '${cols.restricted}', '${other}', 'read')`);
  cols.adminOnly = await insertCollection(run, { tenant_id: A }); // no default permission and no grant: only an administrator reads it
  cols.other = await insertCollection(run, { tenant_id: B, default_permission: 'read' });
  await page(A, cols.open, 'Open page', 'plan notes of the open collection');
  for (const { term, kind } of TERMS) {
    const text = `a page with the word ${term} only here`;
    const id =
      kind === 'restricted'
        ? await page(A, cols.restricted, `Restricted ${term}`, text)
        : kind === 'admin-only'
          ? await page(A, cols.adminOnly, `Admin ${term}`, text)
          : kind === 'trashed'
            ? await page(A, cols.open, `Trashed ${term}`, text, { deleted_at: raw('now()'), deleted_batch: randomUUID() })
            : await page(B, cols.other, `Other tenant ${term}`, text);
    pageOf.set(term, id);
  }
  // The other tenant's page whose chunk is exactly the query vector, in a collection that is readable by everyone of that tenant.
  const nearest = await page(B, cols.other, 'Other tenant nearest', 'meaning only, no shared words');
  pageOf.set('nearest', nearest);
  const written = await store.replacePage(B, nearest, hash(1), modelKey(embedder.model), [{ chunkIndex: 0, contentHash: hash(2), charStart: 0, charEnd: 29, tokenCount: 4, embedding: QUERY }]);
  if (written !== 'ok') throw new Error(`the chunk was not written: ${written}`);
  app = appOver();
}, 120_000);

afterAll(async () => {
  await db.close();
  await ops.close();
  await dropTestDatabase(DB);
});

/** Every page of the answer, followed through its cursors, as raw text (a cursor is also read as what it holds). */
async function answer(query: string, who: string, extra = ''): Promise<{ texts: string[]; ids: string[]; semantic: boolean }> {
  const texts: string[] = [];
  const ids: string[] = [];
  let semantic = false;
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const res = await get(`/v1/search?q=${encodeURIComponent(query)}&limit=2${extra}${cursor === null ? '' : `&cursor=${cursor}`}`, who);
    expect(res.status, query).toBe(200);
    const text = await res.text();
    texts.push(text);
    const body = JSON.parse(text) as { items: { pageId: string }[]; nextCursor: string | null; semantic: boolean };
    semantic = body.semantic;
    ids.push(...body.items.map((i) => i.pageId));
    if (body.nextCursor !== null) texts.push(Buffer.from(body.nextCursor, 'base64url').toString('utf8'));
    cursor = body.nextCursor;
    if (cursor === null) break;
  }
  return { texts, ids, semantic };
}

describe('a word only on a page the asker may not read is never found (tenant model)', () => {
  it.each(TERMS.map((t, i) => [i, t.term, t.kind] as const))('query %i (%s, on a %s page): nothing, in no item, snippet or cursor, and the semantic list adds no page of another tenant', async (i, term, kind) => {
    const found = await answer(term, `a-m${String(i)}`);
    expect(found.ids, `${term} is only on a ${kind} page`).toEqual([]);
    for (const text of found.texts) {
      expect(text).not.toContain(term);
      expect(text).not.toContain(pageOf.get(term) as string);
      expect(text).not.toContain(pageOf.get('nearest') as string);
    }
    expect(found.semantic).toBe(true); // the semantic list was on and still gave nothing of the other tenant, though its chunk is the query vector
  });

  // The title search is fuzzy (trigrams), so a word is also found "nearly" on pages with similar titles: the readers below find THEIR page among others, and the isolation checks look at whose pages the answer holds.
  it('the same words are found by the people who may read them: an administrator in the administrator-only and the restricted collections, the grantee in the restricted one, and the other tenant on its own page', async () => {
    const adminTerm = TERMS.find((t) => t.kind === 'admin-only') as (typeof TERMS)[number];
    const restrictedTerm = TERMS.find((t) => t.kind === 'restricted') as (typeof TERMS)[number];
    const otherTerm = TERMS.find((t) => t.kind === 'other-tenant') as (typeof TERMS)[number];
    expect((await answer(adminTerm.term, 'a-admin')).ids).toContain(pageOf.get(adminTerm.term));
    expect((await answer(restrictedTerm.term, 'a-admin')).ids).toContain(pageOf.get(restrictedTerm.term));
    expect((await answer(restrictedTerm.term, 'a-other')).ids).toContain(pageOf.get(restrictedTerm.term));
    expect((await answer(otherTerm.term, 'b-m0')).ids).toContain(pageOf.get(otherTerm.term));
  });

  it("no answer holds a page of the other tenant: the first tenant's administrator and the other tenant never see each other's pages, whatever the word", async () => {
    const ofB = new Set([...TERMS.filter((t) => t.kind === 'other-tenant').map((t) => pageOf.get(t.term) as string), pageOf.get('nearest') as string]);
    const ofA = new Set(TERMS.filter((t) => t.kind !== 'other-tenant').map((t) => pageOf.get(t.term) as string));
    for (const { term } of TERMS.slice(0, 3)) {
      // few words: one person is allowed 30 requests a minute and an answer follows its cursors
      expect(
        (await answer(term, 'a-admin')).ids.filter((id) => ofB.has(id)),
        `${term} for the first tenant's administrator`,
      ).toEqual([]);
      expect(
        (await answer(term, 'b-m0')).ids.filter((id) => ofA.has(id)),
        `${term} for the other tenant`,
      ).toEqual([]);
    }
  });

  it('an administrator-only collection is invisible to a member even when asked for by id: an empty 200 with no cursor', async () => {
    const adminTerm = TERMS.find((t) => t.kind === 'admin-only') as (typeof TERMS)[number];
    const res = await get(`/v1/search?q=${encodeURIComponent(adminTerm.term)}&collectionId=${cols.adminOnly}`, 'a-m21');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ items: [], nextCursor: null });
    expect(text).not.toContain(adminTerm.term);
  });

  it("the other tenant's collection asked for by id is an empty 200 for the first tenant", async () => {
    const otherTerm = TERMS.find((t) => t.kind === 'other-tenant') as (typeof TERMS)[number];
    const res = await get(`/v1/search?q=${encodeURIComponent(otherTerm.term)}&collectionId=${cols.other}`, 'a-m22');
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toMatchObject({ items: [], nextCursor: null });
  });
});
