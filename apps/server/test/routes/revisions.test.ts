import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { encodeCursor } from '../../src/http/pagination.js';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { admin: 'admin', member: 'member', viewer: 'viewer', outsider: 'member' };
const ANA = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Ana' };
const BOB = { id: '00000000-0000-4000-8000-0000000000b2', name: 'Bob' };

/** A page in `shared` (members write, viewers read) with four revisions, and a page in `closed` that only administrators see. */
function build() {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = Object.entries(ROLES).map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000010${String(i)}`, descopeUserId: `d-${name}`, email: `${name}@example.com`, name, role, suspended: false,
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const shared = collections.seed({ name: 'Shared', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const page = pages.seed({ collectionId: shared.id });
  const hidden = pages.seed({ collectionId: closed.id });
  const revisions = new FakeRevisionRepo();
  const store = createFakeAccessStore(world);
  const access = createPageAccess(store);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: { ...t.ctx.http, users, collections, pages, revisions, provisioner: createProvisioner({ users, verifier, policy: signInPolicy }), access, authorizer: createAuthorizer(store) },
  });
  const call = (who: string, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { authorization: `Bearer ${who}`, ...headers } });
  const four = [10, 20, 30, 40].map((at) => revisions.seed({ pageId: page.id, createdAt: at * 1000, title: `T${String(at)}`, markdown: `M${String(at)}`, authors: [ANA, BOB], lastAuthor: BOB, reason: at === 40 ? 'last_editor_left' : 'idle' }));
  return { call, revisions, page, hidden, four };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
interface Listed { items: { id: string; title: string; createdAt: number; reason: string; lastAuthor: unknown; authors: unknown[]; markdown?: string }[]; nextCursor: string | null }

describe('GET /v1/pages/{id}/revisions', () => {
  it('lists newest first with the reason, the last author and the authors, and no Markdown', async () => {
    const b = build();
    const res = await b.call('member', `/v1/pages/${b.page.id}/revisions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Listed;
    expect(body.items.map((i) => i.title)).toEqual(['T40', 'T30', 'T20', 'T10']);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toEqual({ id: b.four[3]?.id, createdAt: 40_000, title: 'T40', reason: 'last_editor_left', lastAuthor: BOB, authors: [ANA, BOB] });
  });

  it('pages by keyset with nextCursor, without a gap or a repeat, even for revisions with one time', async () => {
    const b = build();
    b.revisions.seed({ pageId: b.page.id, createdAt: 30_000, title: 'T30b' });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await b.call('member', `/v1/pages/${b.page.id}/revisions?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
      const body = (await res.json()) as Listed;
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('pages through times finer than a millisecond without a gap or a repeat, and does not show the sort position', async () => {
    const b = build();
    for (const micros of [0, 1, 2, 3]) b.revisions.seed({ pageId: b.page.id, createdAt: 60_000, extraMicros: micros, title: `fine${String(micros)}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 12; guard += 1) {
      const body = (await (await b.call('member', `/v1/pages/${b.page.id}/revisions?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`)).json()) as Listed;
      expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(['authors', 'createdAt', 'id', 'lastAuthor', 'reason', 'title']);
      seen.push(...body.items.map((i) => i.title));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['fine3', 'fine2', 'fine1', 'fine0', 'T40', 'T30', 'T20', 'T10']);
  });

  it('is open to a viewer and 404 to a user without access to the page', async () => {
    const b = build();
    expect((await b.call('viewer', `/v1/pages/${b.page.id}/revisions`)).status).toBe(200);
    const hidden = await b.call('outsider', `/v1/pages/${b.hidden.id}/revisions`);
    expect([hidden.status, await code(hidden)]).toEqual([404, 'not_found']);
    expect((await b.call('member', '/v1/pages/00000000-0000-4000-8000-000000000999/revisions')).status).toBe(404);
  });

  it('refuses a bad limit, a cursor that is not ours and a hand-made key with 422', async () => {
    const b = build();
    const url = (query: string) => `/v1/pages/${b.page.id}/revisions?${query}`;
    for (const query of ['limit=0', 'limit=101', 'cursor=not-a-cursor', `cursor=${encodeCursor('users', [1, b.page.id])}`, `cursor=${encodeCursor('revisions', [1.5, b.page.id])}`, `cursor=${encodeCursor('revisions', [-1e15, b.page.id])}`, `cursor=${encodeCursor('revisions', [-1, b.page.id])}`, `cursor=${encodeCursor('revisions', [1, 'nope'])}`, `cursor=${encodeCursor('revisions', [1])}`]) {
      const res = await b.call('member', url(query));
      expect([query, res.status, await code(res)]).toEqual([query, 422, 'invalid']);
    }
  });

  it('answers 401 without a token', async () => {
    const b = build();
    expect((await b.call('', `/v1/pages/${b.page.id}/revisions`, { authorization: '' })).status).toBe(401);
  });
});

describe('the revision documents', () => {
  it('shows a last author of null once that user is gone, and still lists the authors', async () => {
    const b = build();
    b.revisions.seed({ pageId: b.page.id, createdAt: 50_000, title: 'Gone', authors: [ANA], lastAuthor: null });
    const body = (await (await b.call('member', `/v1/pages/${b.page.id}/revisions`)).json()) as Listed;
    expect(body.items[0]).toMatchObject({ title: 'Gone', lastAuthor: null, authors: [ANA] });
  });

  it('keeps the shared author component non-null: only lastAuthor may be null', async () => {
    const doc = createApp(makeContext().ctx).getOpenAPIDocument({ openapi: '3.0.3', info: { title: 't', version: '1' } });
    const schemas = doc.components?.schemas as Record<string, { nullable?: boolean; properties?: Record<string, { nullable?: boolean; items?: { $ref?: string } }> }>;
    expect(schemas['RevisionAuthor']?.nullable).not.toBe(true);
    expect(schemas['Revision']?.properties?.['lastAuthor']?.nullable).toBe(true);
    expect(schemas['Revision']?.properties?.['authors']?.items?.$ref).toBe('#/components/schemas/RevisionAuthor');
  });
});

describe('GET /v1/pages/{id}/revisions/{rid}', () => {
  it('returns the revision with its Markdown, to a viewer too', async () => {
    const b = build();
    const res = await b.call('viewer', `/v1/pages/${b.page.id}/revisions/${b.four[1]?.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: b.four[1]?.id, createdAt: 20_000, title: 'T20', markdown: 'M20', reason: 'idle', lastAuthor: BOB, authors: [ANA, BOB] });
  });

  it('is 404 for an unknown revision, for one of another page, and for a user without access', async () => {
    const b = build();
    const other = b.revisions.seed({ pageId: b.hidden.id, createdAt: 1 });
    const unknown = await b.call('member', `/v1/pages/${b.page.id}/revisions/00000000-0000-4000-8000-000000000999`);
    expect([unknown.status, await code(unknown)]).toEqual([404, 'not_found']);
    expect((await b.call('member', `/v1/pages/${b.page.id}/revisions/${other.id}`)).status).toBe(404);
    expect((await b.call('outsider', `/v1/pages/${b.page.id}/revisions/${b.four[0]?.id}`)).status).toBe(200);
    expect((await b.call('outsider', `/v1/pages/${b.hidden.id}/revisions/${other.id}`)).status).toBe(404);
    expect((await b.call('member', `/v1/pages/${b.page.id}/revisions/not-an-id`)).status).toBe(422);
  });
});
