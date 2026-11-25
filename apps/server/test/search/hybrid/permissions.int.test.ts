import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessStore, createDatabase, createEmbeddingStore, createSearchRepo, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Embedder, EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { insertCollection, insertPage, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { createApp } from '../../../src/app.js';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../../server/support/harness.js';
import { makeContext } from '../../server/support/context.js';

// M7-T14: the semantic list and the fused list on the real database. A page in a collection the caller cannot read, whose chunk is exactly the query vector (the best possible match), must
// not show anywhere: not in the items, the snippets, `matchedPassage`, the cursor or anything else the answer says. The test plants a marker string in that page and scans every body for it.
const DB = 'grimoire_m7t14_permissions';
const TENANT = 'legacy';
const MARKER = 'PLANTED-MARKER-7f3a9c';
const DIMS = 4;
const QUERY = Float32Array.from([1, 0, 0, 0]);
const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const run = (sql: string) => sqlAdmin(DB, sql);

/** An embedder with no model: every query is the one vector, so the chunk equal to it is the nearest of all. */
const embedder: Embedder = {
  model: { name: 'fake-e5', version: 'v1', dims: DIMS, maxTokens: 64 },
  status: () => 'ready',
  countTokens: (text) => text.split(/\s+/).length,
  embedPassages: () => Promise.resolve<EmbedResult>({ ok: false, reason: 'unavailable' }),
  embedQuery: () => Promise.resolve<EmbedResult>({ ok: true, vectors: [QUERY] }),
  stats: () => ({ threads: 1, queued: 0, chunksPerMinute: 0 }),
  close: () => Promise.resolve(),
};

let db: KyselyDatabase;
let store: EmbeddingStore;
let open: string;
let hidden: string;
const ids: { open: string[]; hidden: string; trashed: string } = { open: [], hidden: '', trashed: '' };

async function pageWithChunk(collection: string, title: string, text: string, vector: number[], over: Record<string, unknown> = {}): Promise<string> {
  const id = await insertPage(run, { collection_id: collection, title, text_content: text, markdown_hash: raw(`decode('${hex(1)}', 'hex')`), ...over });
  const unit = Float32Array.from(vector);
  const norm = Math.hypot(...vector);
  const embedding = unit.map((x) => x / norm);
  const written = await store.replacePage(TENANT, id, hash(1), modelKey(embedder.model), [{ chunkIndex: 0, contentHash: hash(2), charStart: 0, charEnd: [...text].length, tokenCount: 4, embedding }]);
  if (written !== 'ok') throw new Error(`the chunk of ${title} was not written: ${written}`);
  return id;
}

function appOver() {
  const t = makeContext();
  const config = makeFakeConfig({ allowedEmailDomains: ['example.com'] });
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const users = createUserStore(db, 1000);
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

let app: ReturnType<typeof appOver>;
const get = (path: string) => app.request(path, { headers: { authorization: 'Bearer member' } });

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  db = createDatabase(appUrl(DB));
  store = createEmbeddingStore(db);
  await insertUser(run, { descope_user_id: 'd-member', email: 'member@example.com', role: 'member' });
  open = await insertCollection(run, { default_permission: 'read' });
  hidden = await insertCollection(run, {}); // no default permission and no grant: the member cannot read it
  // Pages the member can read: some near the query, some far. Words shared with the generated queries ("plan", "notes") so the full-text list has rows too.
  for (let i = 0; i < 6; i += 1) ids.open.push(await pageWithChunk(open, `Open ${String(i)}`, `plan notes number ${String(i)} of the open collection`, [1 - i * 0.12, i * 0.5, 0.1, 0.3]));
  // The unreadable page: its chunk IS the query vector, its text and title carry the marker, and it matches the words of the queries too.
  ids.hidden = await pageWithChunk(hidden, `Secret ${MARKER}`, `plan notes ${MARKER} secret passage that must never be shown`, [1, 0, 0, 0]);
  // A trashed page of a readable collection, also exactly the query vector.
  ids.trashed = await pageWithChunk(open, `Trashed ${MARKER}`, `plan notes ${MARKER} in the trash`, [1, 0, 0, 0], { deleted_at: raw('now()'), deleted_batch: randomUUID() });
  app = appOver();
}, 120_000);

afterAll(async () => {
  await db.close();
  await dropTestDatabase(DB);
});

/** Twenty generated queries, the same in every run. */
const queries = Array.from({ length: 20 }, (_, i) => ['plan', 'notes', `number ${String(i % 6)}`, 'open collection', `plan notes ${String(i)}`, 'passage', 'secret', MARKER.toLowerCase()][i % 8] as string);

/** Every page of the answer, followed through its cursors, as raw text. */
async function bodies(query: string, extra = ''): Promise<{ texts: string[]; items: { pageId: string; collectionId: string }[] }> {
  const texts: string[] = [];
  const items: { pageId: string; collectionId: string }[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const res = await get(`/v1/search?q=${encodeURIComponent(query)}&limit=2${extra}${cursor === null ? '' : `&cursor=${cursor}`}`);
    expect(res.status, query).toBe(200);
    const text = await res.text();
    texts.push(text);
    const body = JSON.parse(text) as { items: { pageId: string; collectionId: string }[]; nextCursor: string | null };
    items.push(...body.items);
    if (body.nextCursor === null) break;
    cursor = body.nextCursor;
  }
  return { texts, items };
}

describe('the semantic list and the fused list never show a page the caller cannot read', () => {
  it('the store itself answers only the collections it is given: the unreadable page is not the nearest chunk, it is not there', async () => {
    const hits = await store.search(TENANT, QUERY, { model: modelKey(embedder.model), collectionIds: [open], limit: 100, minSimilarity: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.pageId)).not.toContain(ids.hidden);
    expect(hits.map((h) => h.pageId)).not.toContain(ids.trashed);
    expect(JSON.stringify(hits)).not.toContain(MARKER);
    const none = await store.search(TENANT, QUERY, { model: modelKey(embedder.model), collectionIds: [], limit: 100, minSimilarity: 0 });
    expect(none).toEqual([]);
  });

  it.each(queries.map((q, i) => [i, q] as const))('query %i (%s): no body of the whole answer, cursors included, holds the marker, the unreadable page or the trashed one', async (_i, query) => {
    const answer = await bodies(query);
    for (const text of answer.texts) {
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain(ids.hidden);
      expect(text).not.toContain(ids.trashed);
    }
    expect(answer.items.map((i) => i.collectionId).every((c) => c === open)).toBe(true);
    expect(answer.items.length).toBeGreaterThan(0); // the readable pages are found (by meaning at least): the scan above is not passing on an empty answer
    const semantic = await get(`/v1/search?q=${encodeURIComponent(query)}&limit=2`);
    expect(((await semantic.json()) as { semantic: boolean }).semantic).toBe(true);
  });

  it('a collection the caller cannot read, asked for by id, is an empty 200 with no cursor', async () => {
    for (const query of queries.slice(0, 4)) {
      const res = await get(`/v1/search?q=${encodeURIComponent(query)}&collectionId=${hidden}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ items: [], nextCursor: null });
      expect(text).not.toContain(MARKER);
    }
  });

  it('a readable collection asked for by id gives only its pages, and the trashed page is absent from it', async () => {
    const answer = await bodies('plan notes', `&collectionId=${open}`);
    expect(answer.items.map((i) => i.pageId)).not.toContain(ids.trashed);
    expect(new Set(answer.items.map((i) => i.pageId)).size).toBe(answer.items.length); // each page once through the cursors
  });
});
