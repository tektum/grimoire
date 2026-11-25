import { describe, expect, it } from 'vitest';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import { SearchTimeoutError } from '@tektum/grimoire-core/ports/search-repo';
import { InvalidSearchCursor } from '@tektum/grimoire-core/search/cursor';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeSearchRepo } from '@tektum/grimoire-core/testing/fake-search-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const PAGE = (n: number) => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`;

/** Two people in one tenant: `member` reads `Open` and `Shared`; `closed` is a collection only administrators read. */
function build(openPermission: 'read' | null = 'read') {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = [['member', 'member'], ['admin', 'admin']].map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000060${String(i)}`, descopeUserId: `d-${name}`, email: `${name}@example.com`, name: name as string, role: role as 'member' | 'admin', suspended: false, tenantId: 'legacy',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: openPermission });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const search = new FakeSearchRepo();
  const hit = (n: number, collectionId: string, over: object = {}) => search.seed({ tenantId: 'legacy', pageId: PAGE(n), urlId: `u${String(n)}`, title: `Page ${String(n)}`, collectionId, snippet: { text: 'a match here', ranges: [[2, 7]] }, partial: false, updatedAt: 1_700_000_000_000, rank: 0.5, ...over });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: { ...t.ctx.http, users, collections, search, idempotency: new FakeIdempotencyStore(t.clock), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }), access: createPageAccess(store), authorizer: createAuthorizer(store) },
  });
  const call = (who: string | undefined, query: string) => app.request(`/v1/search${query}`, { headers: who === undefined ? {} : { authorization: `Bearer ${who}` } });
  return { call, search, hit, open: open.id, closed: closed.id, logger: t.logger, clock: t.clock };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('GET /v1/search', () => {
  it('answers 401 without a token', async () => {
    expect((await build().call(undefined, '?q=plan')).status).toBe(401);
  });

  it('answers 422 invalid for a missing, an empty and a 201-character q, for limit 51, limit 0 and a bad cursor', async () => {
    const { call } = build();
    for (const query of ['', '?q=', '?q=%20%20', `?q=${'a'.repeat(201)}`, '?q=plan&limit=51', '?q=plan&limit=0', '?q=plan&limit=x', '?q=plan&cursor=not-a-cursor', '?q=plan&collectionId=nope']) {
      const res = await call('member', query);
      expect([query, res.status, await code(res)]).toEqual([query, 422, 'invalid']);
    }
    expect((await call('member', `?q=${'a'.repeat(200)}`)).status).toBe(200);
  });

  it('answers items of the exact shape the web client reads, with the readable pages only', async () => {
    const { call, hit, open, closed, search } = build();
    hit(1, open);
    hit(2, closed);
    hit(3, open, { partial: true });
    const res = await call('member', '?q=plan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[]; nextCursor: string | null; semantic: boolean };
    expect(body.items.map((i) => i['pageId'])).toEqual([PAGE(1), PAGE(3)]);
    expect(body.items[0]).toEqual({
      pageId: PAGE(1), urlId: 'u1', title: 'Page 1', snippet: { text: 'a match here', ranges: [[2, 7]] }, collectionId: open, rank: 0.5, updatedAt: '2023-11-14T22:13:20.000Z',
    });
    expect(body.items[1]).toMatchObject({ partial: true });
    expect(body.nextCursor).toBeNull();
    expect(body.semantic).toBe(false);
    expect(search.requests[0]).toMatchObject({ tenantId: 'legacy', query: 'plan', limit: 20, collectionIds: [open] });
  });

  it('trims q, passes limit and collectionId, and gives the administrator the closed collection too', async () => {
    const { call, hit, open, closed, search } = build();
    hit(1, open);
    hit(2, closed);
    await call('member', `?q=%20plan%20&limit=7&collectionId=${open}`);
    expect(search.requests[0]).toMatchObject({ query: 'plan', limit: 7, collectionId: open });
    const admin = (await (await call('admin', '?q=plan')).json()) as { items: { pageId: string }[] };
    expect(admin.items.map((i) => i.pageId).sort()).toEqual([PAGE(1), PAGE(2)]);
  });

  it('answers a collection the person cannot read with an empty list and 200, never 404', async () => {
    const { call, hit, closed } = build();
    hit(2, closed);
    const res = await call('member', `?q=plan&collectionId=${closed}`);
    expect([res.status, ((await res.json()) as { items: unknown[] }).items]).toEqual([200, []]);
  });

  it('does not ask the repository at all when the person may read no collection, and answers an empty list', async () => {
    const { call, search, hit, open } = build(null); // `Open` is closed too: the member reads nothing
    hit(1, open);
    const res = await call('member', '?q=plan');
    expect([res.status, await res.json()]).toEqual([200, { items: [], nextCursor: null, semantic: false }]);
    expect(search.requests).toEqual([]);
  });

  it('hands the cursor to the repository and returns the one it gave back', async () => {
    const { call, search, hit, open } = build();
    hit(1, open);
    const next = Buffer.from(JSON.stringify({ k: [0.5, 1, PAGE(1)] })).toString('base64url');
    const original = search.search.bind(search);
    search.search = (r) => original(r).then((p) => ({ ...p, nextCursor: next }));
    const first = (await (await call('member', '?q=plan')).json()) as { nextCursor: string };
    expect(first.nextCursor).toBe(next);
    await call('member', `?q=plan&cursor=${next}`);
    expect(search.requests[1]?.cursor).toBe(next);
  });

  it('answers a cursor the repository refuses as 422 invalid, and a timeout as 503 unavailable with the event search.timeout', async () => {
    const { call, search, logger } = build();
    const cursor = Buffer.from(JSON.stringify({ k: [1e100, 1, PAGE(1)] })).toString('base64url'); // well formed JSON, refused by the cursor rules
    const bad = await call('member', `?q=plan&cursor=${cursor}`);
    expect([bad.status, await code(bad)]).toEqual([422, 'invalid']);
    search.failNext = new InvalidSearchCursor(); // the repository's own check, behind the route's
    const behind = await call('member', '?q=plan');
    expect([behind.status, await code(behind)]).toEqual([422, 'invalid']);
    search.failNext = new SearchTimeoutError();
    const slow = await call('member', '?q=plan');
    expect([slow.status, await code(slow)]).toEqual([503, 'unavailable']);
    expect(logger.entries.filter((e) => e.event === 'search.timeout')).toHaveLength(1);
  });

  it('answers a failure it does not know with the standard 503 envelope, and logs its class and nothing of its message', async () => {
    const { call, search, logger } = build();
    search.failNext = new Error('the password is secret-pass-phrase');
    const res = await call('member', '?q=plan');
    expect([res.status, await code(res)]).toEqual([503, 'unavailable']);
    expect(logger.entries.some((e) => e.event === 'http.handler_error')).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain('secret-pass-phrase');
  });

  it('is limited to 30 requests in 60 seconds: the 31st is 429', async () => {
    const { call } = build();
    for (let i = 0; i < 30; i += 1) expect((await call('member', '?q=plan')).status, `request ${String(i + 1)}`).toBe(200);
    expect((await call('member', '?q=plan')).status).toBe(429);
  });

  it('logs the duration and the count of a search and nothing of its text', async () => {
    const { call, hit, open, search, logger } = build();
    hit(1, open, { title: 'Quarterly secret roadmap', snippet: { text: 'secret roadmap text', ranges: [] } });
    search.seed({ tenantId: 'legacy', pageId: PAGE(9), urlId: 'u9', title: 'x', collectionId: open, snippet: { text: '', ranges: [] }, partial: false, updatedAt: 1, rank: 1 });
    await call('member', '?q=hunter2-needle');
    const debug = logger.entries.find((e) => e.event === 'search.query');
    expect(debug?.fields).toEqual({ ms: expect.any(Number), results: 2 });
    const everything = JSON.stringify(logger.entries);
    expect(everything).not.toContain('hunter2-needle');
    expect(everything).not.toContain('secret roadmap');
  });
});
