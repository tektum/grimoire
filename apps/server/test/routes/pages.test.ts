import { describe, expect, it } from 'vitest';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import * as Y from 'yjs';
import { convertInProcess, reseedInProcess, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageRepo } from '@tektum/grimoire-core/testing/fake-page-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { admin: 'admin', member: 'member', outsider: 'member' };

/** Three people over `open` (everyone reads; members only read) and `shared` (members write), plus `closed` (administrators only). */
function build(realConverter?: MarkdownConverter) {
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
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read' });
  const shared = collections.seed({ name: 'Shared', description: null, icon: null, color: null, position: 'a2', defaultPermission: 'read_write' });
  const shared2 = collections.seed({ name: 'Shared two', description: null, icon: null, color: null, position: 'a4', defaultPermission: 'read_write' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a3', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const fake = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown: 'canonical', text: 'canonical' } });
  const converter = realConverter ?? fake;
  const store = createFakeAccessStore(world);
  const access = createPageAccess(store);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, collections, pages, converter, idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access, authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, pages, collections, converter: fake, world, open, shared, shared2, closed, rows, access };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const make = (b: ReturnType<typeof build>, body: Record<string, unknown>, who = 'member') => b.call(who, 'POST', '/v1/pages', body);
const meta = async (res: Response) => (await res.json()) as { id: string; position: string; parentId: string | null; collectionId: string; createdBy: string; title: string };

describe('POST /v1/pages', () => {
  it('creates a page last, or after a sibling, in position order', async () => {
    const b = build();
    const first = await meta(await make(b, { collectionId: b.shared.id, title: 'One' }));
    const last = await meta(await make(b, { collectionId: b.shared.id, title: 'Three' }));
    const between = await meta(await make(b, { collectionId: b.shared.id, title: 'Two', afterId: first.id }));
    expect(first.position < between.position && between.position < last.position).toBe(true);
    const top = await meta(await make(b, { collectionId: b.shared.id, title: 'Four', afterId: last.id }));
    expect(top.position > last.position).toBe(true);
    expect(first).toMatchObject({ collectionId: b.shared.id, parentId: null, createdBy: b.rows[1]?.id, title: 'One' });
  });

  it('creates a child page under a parent of the same collection', async () => {
    const b = build();
    const parent = await meta(await make(b, { collectionId: b.shared.id, title: 'P' }));
    const child = await meta(await make(b, { collectionId: b.shared.id, parentId: parent.id, title: 'C' }));
    expect(child.parentId).toBe(parent.id);
  });

  it('is 403 to a reader without write, and 404 for a collection, a parent or a sibling the caller cannot use', async () => {
    const b = build();
    const reader = await make(b, { collectionId: b.open.id });
    expect([reader.status, await code(reader)]).toEqual([403, 'forbidden']);
    const hidden = await make(b, { collectionId: b.closed.id }, 'outsider');
    expect([hidden.status, await code(hidden)]).toEqual([404, 'not_found']);
    const parent = await make(b, { collectionId: b.shared.id, parentId: '00000000-0000-4000-8000-000000000999' });
    expect([parent.status, await code(parent)]).toEqual([404, 'not_found']);
    const other = b.pages.seed({ collectionId: b.closed.id });
    expect((await make(b, { collectionId: b.shared.id, parentId: other.id })).status).toBe(404);
  });

  it('refuses a sibling that is not under the same parent, a title of 256 characters, unknown fields and a bad id with 422', async () => {
    const b = build();
    const parent = await meta(await make(b, { collectionId: b.shared.id }));
    const nested = await meta(await make(b, { collectionId: b.shared.id, parentId: parent.id }));
    for (const body of [
      { collectionId: b.shared.id, afterId: nested.id },
      { collectionId: b.shared.id, afterId: '00000000-0000-4000-8000-000000000999' },
      { collectionId: b.shared.id, title: 'x'.repeat(256) },
      { collectionId: b.shared.id, title: '' },
      { collectionId: b.shared.id, title: 'a\u0000b' },
      { collectionId: b.shared.id, surprise: 1 },
      { collectionId: 'nope' },
      {},
    ]) {
      const res = await make(b, body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
    expect((await make(b, { collectionId: b.shared.id, title: 'x'.repeat(255) })).status).toBe(201);
  });

  it('refuses the 33rd level with 409 too_deep and the 10,001st page with 409 collection_full', async () => {
    const b = build();
    let parentId: string | null = null;
    for (let level = 1; level <= 32; level += 1) parentId = (await meta(await make(b, { collectionId: b.shared.id, ...(parentId === null ? {} : { parentId }) }))).id;
    const deep = await make(b, { collectionId: b.shared.id, parentId });
    expect([deep.status, await code(deep)]).toEqual([409, 'too_deep']);
    for (let n = 32; n < 10_000; n += 1) b.pages.seed({ collectionId: b.shared.id });
    const full = await make(b, { collectionId: b.shared.id });
    expect([full.status, await code(full)]).toEqual([409, 'collection_full']);
    expect((await make(b, { collectionId: b.closed.id }, 'admin')).status).toBe(201);
  });

  it('refuses a collection deleted after the caller was checked, in the same step as the insert, and stores nothing', async () => {
    const b = build();
    b.pages.beforeInsert = () => b.collections.markDeleted(b.shared.id);
    const res = await make(b, { collectionId: b.shared.id });
    expect([res.status, await code(res)]).toEqual([409, 'collection_deleted']);
    expect(b.pages.count()).toBe(0);
  });

  it('creates one page for the same Idempotency-Key', async () => {
    const b = build();
    const a = await b.call('member', 'POST', '/v1/pages', { collectionId: b.shared.id }, { 'idempotency-key': 'k' });
    const again = await b.call('member', 'POST', '/v1/pages', { collectionId: b.shared.id }, { 'idempotency-key': 'k' });
    expect([a.status, again.status, again.headers.get('idempotent-replay')]).toEqual([201, 201, 'true']);
    expect(b.pages.count()).toBe(1);
  });
});

describe('a retry with the same Idempotency-Key', () => {
  const first = (b: ReturnType<typeof build>) => b.call('member', 'POST', '/v1/pages', { collectionId: b.shared.id }, { 'idempotency-key': 'k' });
  const retry = (b: ReturnType<typeof build>) => b.call('member', 'POST', '/v1/pages', { collectionId: b.shared.id }, { 'idempotency-key': 'k' });

  it('is refused 403 when write access was taken away since the first answer, and creates nothing new', async () => {
    const b = build();
    expect((await first(b)).status).toBe(201);
    await b.collections.update(b.shared.id, { defaultPermission: 'read' }, b.rows[0]?.id as string);
    const res = await retry(b);
    expect([res.status, await code(res), b.pages.count()]).toEqual([403, 'forbidden', 1]);
  });

  it('is refused 404 when read access was taken away or the collection was deleted', async () => {
    const gone = build();
    await first(gone);
    await gone.collections.update(gone.shared.id, { defaultPermission: null }, gone.rows[0]?.id as string);
    expect((await retry(gone)).status).toBe(404);
    const deleted = build();
    await first(deleted);
    await deleted.collections.softDelete(deleted.shared.id, deleted.rows[0]?.id as string);
    expect((await retry(deleted)).status).toBe(404);
  });

  it('still replays the stored answer while access holds', async () => {
    const b = build();
    const a = await first(b);
    const again = await retry(b);
    expect([again.status, again.headers.get('idempotent-replay')]).toEqual([201, 'true']);
    expect(await again.json()).toEqual(await a.json());
  });
});

describe('POST /v1/pages with Markdown', () => {
  it('seeds with the user id as the key and stores the canonical Markdown with its state', async () => {
    const b = build();
    const page = await meta(await make(b, { collectionId: b.shared.id, title: 'T', markdown: '# raw' }));
    expect(b.converter.seedKeys).toEqual([b.rows[1]?.id]);
    expect(b.converter.seedCalls).toEqual(['# raw']);
    expect(b.pages.stored(page.id)).toMatchObject({ markdown: 'canonical', state: new Uint8Array([1, 2, 3]) });
  });

  it('stores no Markdown and no state for a page created without it', async () => {
    const b = build();
    const page = await meta(await make(b, { collectionId: b.shared.id }));
    expect(b.pages.stored(page.id)).toEqual({ markdown: null, state: null, hash: null });
    expect(b.converter.seedCalls).toEqual([]);
  });

  const refused = (seed: SeedResult) => async () => {
    const b = build();
    b.converter.enqueueSeed(seed);
    return { b, res: await make(b, { collectionId: b.shared.id, markdown: 'x' }) };
  };

  it('answers a limit or a bad document with 422 and the converter\'s sentence, and inserts no row', async () => {
    for (const reason of ['too-large', 'invalid-markdown'] as const) {
      const { b, res } = await refused({ ok: false, reason, detail: 'limit', message: 'The Markdown is over 131072 bytes.' })();
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      expect([res.status, error.code, error.message, b.pages.count()]).toEqual([422, 'invalid', 'The Markdown is over 131072 bytes.', 0]);
    }
  });

  it('keeps the limit sentence of a too-large seed that came without a message, in its detail', async () => {
    const { res } = await refused({ ok: false, reason: 'too-large', detail: 'The Markdown is over 131072 bytes.' })();
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('The Markdown is over 131072 bytes.');
  });

  it('answers a conversion that used up its time with 422, and a state the serialiser cannot take back with 422', async () => {
    const { b, res } = await refused({ ok: false, reason: 'timeout', detail: 'x' })();
    expect([res.status, await code(res), b.pages.count()]).toEqual([422, 'invalid', 0]);
    for (const reason of ['timeout', 'content-lost', 'invalid-state', 'too-large'] as const) {
      const c = build();
      c.converter.enqueueConvert({ ok: false, reason, detail: 'x' });
      const answer = await make(c, { collectionId: c.shared.id, markdown: 'x' });
      expect([reason, answer.status, c.pages.count()]).toEqual([reason, 422, 0]);
    }
  });

  it('answers a saturated pool with 503, the busy sentence and Retry-After 5, and inserts no row', async () => {
    for (const seed of [
      { ok: false, reason: 'internal', detail: 'queue-full' },
      { ok: false, reason: 'queue-timeout', detail: 'wait' },
    ] as const) {
      const { b, res } = await refused(seed)();
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      expect([res.status, error.code, res.headers.get('retry-after'), b.pages.count()]).toEqual([503, 'unavailable', '5', 0]);
      expect(error.message).toBe('The converter is busy with other pages. Try again in a moment.');
    }
  });

  it('lets one user have one conversion in flight: the second is 429 with Retry-After, another user is not held', async () => {
    const b = build();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seed = b.converter.seed.bind(b.converter);
    b.converter.seed = async (markdown, key) => { await gate; return seed(markdown, key); };
    const first = make(b, { collectionId: b.shared.id, markdown: 'one' });
    const second = make(b, { collectionId: b.shared.id, markdown: 'two' });
    const other = make(b, { collectionId: b.shared.id, markdown: 'three' }, 'admin');
    const refusedSecond = await second;
    expect([refusedSecond.status, await code(refusedSecond), refusedSecond.headers.get('retry-after')]).toEqual([429, 'rate_limited', '2']);
    release();
    expect([(await first).status, (await other).status]).toEqual([201, 201]);
    expect(b.pages.count()).toBe(2);
    // The slot is free again once the work is done: the same user converts once more.
    expect((await make(b, { collectionId: b.shared.id, markdown: 'four' })).status).toBe(201);
  });

  it('frees the slot after a refused conversion too', async () => {
    const b = build();
    b.converter.enqueueSeed({ ok: false, reason: 'invalid-markdown', detail: 'x' });
    expect((await make(b, { collectionId: b.shared.id, markdown: 'bad' })).status).toBe(422);
    expect((await make(b, { collectionId: b.shared.id, markdown: 'good' })).status).toBe(201);
  });
});

interface Detail {
  id: string; urlId: string; collectionId: string; parentId: string | null; title: string; icon: string | null; createdBy: string;
  lastEditedBy: string | null; lastEditedAt: number | null; savedAt: number; stateEpoch: number; myPermission: string;
  breadcrumb: { id: string; title: string }[]; markdownStale: boolean; markdownStaleSince: number | null;
}

describe('GET /v1/pages/{id}', () => {
  it('returns every field of R6.23, the breadcrumb from the root, and the caller\'s permission', async () => {
    const b = build();
    const root = b.pages.seed({ collectionId: b.shared.id, title: 'Root' });
    const mid = b.pages.seed({ collectionId: b.shared.id, title: 'Mid', parentId: root.id });
    const leaf = b.pages.seed({ collectionId: b.shared.id, title: 'Leaf', parentId: mid.id, icon: '*' });
    const res = await b.call('member', 'GET', `/v1/pages/${leaf.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as Detail).toMatchObject({
      id: leaf.id, urlId: leaf.urlId, collectionId: b.shared.id, parentId: mid.id, title: 'Leaf', icon: '*', createdBy: leaf.createdBy,
      lastEditedBy: null, lastEditedAt: null, savedAt: 0, stateEpoch: 0, myPermission: 'read-write',
      breadcrumb: [{ id: root.id, title: 'Root' }, { id: mid.id, title: 'Mid' }], markdownStale: false, markdownStaleSince: null,
    });
    const top = (await (await b.call('member', 'GET', `/v1/pages/${root.id}`)).json()) as Detail;
    expect(top.breadcrumb).toEqual([]);
  });

  it('says read-only where the caller can only read', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.open.id });
    expect(((await (await b.call('member', 'GET', `/v1/pages/${page.id}`)).json()) as Detail).myPermission).toBe('read-only');
  });

  it('tells a stale Markdown from a current one, with the time', async () => {
    const b = build();
    const stale = b.pages.seed({ collectionId: b.shared.id, markdownStaleSince: 1234 });
    const fresh = b.pages.seed({ collectionId: b.shared.id });
    expect(await (await b.call('member', 'GET', `/v1/pages/${stale.id}`)).json()).toMatchObject({ markdownStale: true, markdownStaleSince: 1234 });
    expect(await (await b.call('member', 'GET', `/v1/pages/${fresh.id}`)).json()).toMatchObject({ markdownStale: false, markdownStaleSince: null });
  });

  it('calls a page with editing state and no saved Markdown stale, with no time (reset and restore treat it the same way)', async () => {
    const b = build();
    const stateOnly = b.pages.seed({ collectionId: b.shared.id, hasState: true });
    expect(await (await b.call('member', 'GET', `/v1/pages/${stateOnly.id}`)).json()).toMatchObject({ markdownStale: true, markdownStaleSince: null });
  });

  it('is 404, with one answer, for a page the caller cannot read, a deleted one and an unknown id', async () => {
    const b = build();
    const hidden = b.pages.seed({ collectionId: b.closed.id });
    const answers = [
      await b.call('outsider', 'GET', `/v1/pages/${hidden.id}`),
      await b.call('member', 'GET', '/v1/pages/00000000-0000-4000-8000-000000000999'),
    ];
    const bodies = await Promise.all(answers.map(async (r) => [r.status, await r.json()]));
    expect(bodies[0]).toEqual([404, { error: { code: 'not_found', message: 'Not found.' } }]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect((await b.call('member', 'GET', '/v1/pages/not-an-id')).status).toBe(422);
    await b.collections.softDelete(b.closed.id, b.rows[0]?.id as string);
    expect((await b.call('admin', 'GET', `/v1/pages/${hidden.id}`)).status).toBe(404);
  });

  it('answers 404 when the page disappears between the check and the read', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    b.pages.get = () => Promise.resolve(undefined);
    expect((await b.call('member', 'GET', `/v1/pages/${page.id}`)).status).toBe(404);
  });
});

describe('GET /v1/pages/by-url-id/{urlId}', () => {
  it('returns the same page as by id, and 404 for an unknown or an unreadable URL id', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id, title: 'Findable', urlId: 'abc123' });
    const hidden = b.pages.seed({ collectionId: b.closed.id, urlId: 'hidden1' });
    const byUrl = await b.call('member', 'GET', '/v1/pages/by-url-id/abc123');
    expect(byUrl.status).toBe(200);
    expect(await byUrl.json()).toEqual(await (await b.call('member', 'GET', `/v1/pages/${page.id}`)).json());
    const unknown = await b.call('member', 'GET', '/v1/pages/by-url-id/nothing');
    const unreadable = await b.call('outsider', 'GET', `/v1/pages/by-url-id/${hidden.urlId}`);
    expect([unknown.status, unreadable.status]).toEqual([404, 404]);
    expect(await unknown.json()).toEqual(await unreadable.json());
  });

  it('runs the same one access check for an unknown URL id as for an unreadable page', async () => {
    const b = build();
    const hidden = b.pages.seed({ collectionId: b.closed.id, urlId: 'hidden2' });
    const checks: string[] = [];
    const access = b.access;
    const original = access.pageAccess.bind(access);
    access.pageAccess = (r, o) => { checks.push(r.pageId); return original(r, o); };
    await b.call('outsider', 'GET', `/v1/pages/by-url-id/${hidden.urlId}`);
    await b.call('outsider', 'GET', '/v1/pages/by-url-id/unknown');
    expect(checks).toHaveLength(2);
  });
});

describe('PATCH /v1/pages/{id}', () => {
  it('changes the title and the icon and clears the icon with null', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id, title: 'Old', icon: '*' });
    const res = await b.call('member', 'PATCH', `/v1/pages/${page.id}`, { title: 'New', icon: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: page.id, title: 'New', icon: null });
    expect(await (await b.call('member', 'PATCH', `/v1/pages/${page.id}`, { icon: 'rocket' })).json()).toMatchObject({ title: 'New', icon: 'rocket' });
  });

  it('moves the stored hash with the title, so a following save with the same Markdown is a skip', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id, title: 'Old', markdown: '# body' });
    await b.call('member', 'PATCH', `/v1/pages/${page.id}`, { title: 'New' });
    expect(b.pages.stored(page.id)?.hash?.equals(markdownHash('New', '# body'))).toBe(true);
    await b.call('member', 'PATCH', `/v1/pages/${page.id}`, { icon: 'x' });
    expect(b.pages.stored(page.id)?.hash?.equals(markdownHash('New', '# body'))).toBe(true);
  });

  it('is 403 to a reader without write and 404 to a user who cannot read', async () => {
    const b = build();
    const open = b.pages.seed({ collectionId: b.open.id });
    const hidden = b.pages.seed({ collectionId: b.closed.id });
    const reader = await b.call('member', 'PATCH', `/v1/pages/${open.id}`, { title: 'X' });
    expect([reader.status, await code(reader)]).toEqual([403, 'forbidden']);
    const outsider = await b.call('outsider', 'PATCH', `/v1/pages/${hidden.id}`, { title: 'X' });
    expect([outsider.status, await code(outsider)]).toEqual([404, 'not_found']);
  });

  it('refuses any other field, an empty patch, a long or NUL title and a long icon with 422', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    for (const body of [{ markdown: 'x' }, { collectionId: b.open.id }, { parentId: null }, {}, { title: '' }, { title: 'x'.repeat(256) }, { title: 'a\u0000b' }, { icon: 'x'.repeat(65) }, { icon: 'a\u0000b' }]) {
      const res = await b.call('member', 'PATCH', `/v1/pages/${page.id}`, body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
  });

  it('answers 404 when the page disappears between the check and the change', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    b.pages.updateMeta = () => Promise.resolve(undefined);
    expect((await b.call('member', 'PATCH', `/v1/pages/${page.id}`, { title: 'X' })).status).toBe(404);
  });
});

describe('POST /v1/pages/{id}/move', () => {
  const move = (b: ReturnType<typeof build>, id: string, body: unknown, who = 'member') => b.call(who, 'POST', `/v1/pages/${id}/move`, body);

  it('puts a page under a parent, after a sibling, or at the top level, in position order', async () => {
    const b = build();
    const p = b.pages.seed({ collectionId: b.shared.id, position: 'a' });
    const q = b.pages.seed({ collectionId: b.shared.id, position: 'b' });
    const r = b.pages.seed({ collectionId: b.shared.id, position: 'c' });
    const under = await meta(await move(b, r.id, { parentId: p.id }));
    expect([under.parentId, under.collectionId]).toEqual([p.id, b.shared.id]);
    const after = await meta(await move(b, r.id, { parentId: null, afterId: p.id }));
    expect(after.parentId).toBeNull();
    expect(after.position > 'a' && after.position < 'b').toBe(true);
    const last = await meta(await move(b, p.id, { parentId: null }));
    expect(last.position > q.position && last.position > after.position).toBe(true);
  });

  it('refuses a page under itself or under one of its descendants with 409 would_create_cycle', async () => {
    const b = build();
    const a = b.pages.seed({ collectionId: b.shared.id });
    const child = b.pages.seed({ collectionId: b.shared.id, parentId: a.id });
    const leaf = b.pages.seed({ collectionId: b.shared.id, parentId: child.id });
    for (const target of [a.id, child.id, leaf.id]) {
      const res = await move(b, a.id, { parentId: target });
      expect([res.status, await code(res)]).toEqual([409, 'would_create_cycle']);
    }
  });

  it('counts the moved subtree against the depth: a chain of 31 takes a leaf but not a page with a child', async () => {
    const b = build();
    let parent: string | undefined;
    for (let level = 1; level <= 31; level += 1) parent = b.pages.seed({ collectionId: b.shared.id, ...(parent === undefined ? {} : { parentId: parent }) }).id;
    const leaf = b.pages.seed({ collectionId: b.shared.id });
    const branch = b.pages.seed({ collectionId: b.shared.id });
    b.pages.seed({ collectionId: b.shared.id, parentId: branch.id });
    expect((await move(b, leaf.id, { parentId: parent as string })).status).toBe(200);
    const deep = await move(b, branch.id, { parentId: parent as string });
    expect([deep.status, await code(deep)]).toEqual([409, 'too_deep']);
  });

  it('moves the subtree to another collection when the caller may write in both', async () => {
    const b = build();
    const top = b.pages.seed({ collectionId: b.shared.id });
    const kid = b.pages.seed({ collectionId: b.shared.id, parentId: top.id });
    const res = await meta(await move(b, top.id, { collectionId: b.shared2.id, parentId: null }));
    expect(res.collectionId).toBe(b.shared2.id);
    expect(((await (await b.call('member', 'GET', `/v1/pages/${kid.id}`)).json()) as Detail).collectionId).toBe(b.shared2.id);
  });

  it('needs write on the target collection: 403 where the caller only reads, 404 where they cannot read', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const reader = await move(b, page.id, { collectionId: b.open.id, parentId: null });
    expect([reader.status, await code(reader)]).toEqual([403, 'forbidden']);
    const hidden = await move(b, page.id, { collectionId: b.closed.id, parentId: null });
    expect([hidden.status, await code(hidden)]).toEqual([404, 'not_found']);
  });

  it('needs write on the page: 403 to a reader, 404 to a user who cannot read', async () => {
    const b = build();
    const open = b.pages.seed({ collectionId: b.open.id });
    const hidden = b.pages.seed({ collectionId: b.closed.id });
    expect((await move(b, open.id, { parentId: null })).status).toBe(403);
    expect((await move(b, hidden.id, { parentId: null }, 'outsider')).status).toBe(404);
  });

  it('refuses a parent that is not in the target collection with 404 and a sibling that is not under the new parent with 422', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const elsewhere = b.pages.seed({ collectionId: b.shared2.id });
    expect((await move(b, page.id, { parentId: elsewhere.id })).status).toBe(404);
    const sibling = b.pages.seed({ collectionId: b.shared.id });
    const nested = b.pages.seed({ collectionId: b.shared.id, parentId: sibling.id });
    for (const afterId of [nested.id, page.id, '00000000-0000-4000-8000-000000000999']) {
      const res = await move(b, page.id, { parentId: null, afterId });
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
  });

  it('refuses a move that would take the target collection above 10,000 pages with 409 collection_full', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    for (let n = 0; n < 10_000; n += 1) b.pages.seed({ collectionId: b.shared2.id });
    const res = await move(b, page.id, { collectionId: b.shared2.id, parentId: null });
    expect([res.status, await code(res)]).toEqual([409, 'collection_full']);
    expect((await move(b, page.id, { parentId: null })).status).toBe(200);
  });

  it('refuses a bad body with 422: parentId missing, unknown fields, a bad id', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    for (const body of [{}, { parentId: null, surprise: 1 }, { parentId: 'nope' }, { parentId: null, collectionId: 'nope' }]) {
      const res = await move(b, page.id, body);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
  });

  it('hands the repository the collection it was checked against, and a page that left it is a 409', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const seen: string[] = [];
    const original = b.pages.move.bind(b.pages);
    b.pages.move = (id, to, limits, position) => { seen.push(to.expectedCollectionId); return original(id, to, limits, position); };
    expect((await move(b, page.id, { parentId: null })).status).toBe(200);
    expect(seen).toEqual([b.shared.id]);
    // Another user moves the page to another collection after the caller's check and before the move runs.
    const get = b.pages.get.bind(b.pages);
    b.pages.get = async (id) => { const found = await get(id); await original(id, { expectedCollectionId: b.shared.id, collectionId: b.shared2.id, parentId: null, afterId: null }, { maxDepth: 32, maxPages: 10_000 }, (x, y) => x ?? y ?? 'm'); return found; };
    const raced = await move(b, page.id, { parentId: null });
    expect([raced.status, await code(raced)]).toEqual([409, 'conflict']);
    expect(((await (await b.call('member', 'GET', `/v1/pages/${page.id}`)).json()) as Detail).collectionId).toBe(b.shared2.id);
  });

  it('checks write access on the collection the page is in when the move starts, not the one it was in at the page check', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const get = b.pages.get.bind(b.pages);
    const original = b.pages.move.bind(b.pages);
    // After the page check another user moves the page into a collection the caller can only read.
    b.pages.get = async (id) => {
      await original(id, { expectedCollectionId: b.shared.id, collectionId: b.open.id, parentId: null, afterId: null }, { maxDepth: 32, maxPages: 10_000 }, (x, y) => x ?? y ?? 'm');
      return get(id);
    };
    const res = await move(b, page.id, { parentId: null });
    expect([res.status, await code(res)]).toEqual([403, 'forbidden']);
    expect(((await (await b.call('admin', 'GET', `/v1/pages/${page.id}`)).json()) as Detail).collectionId).toBe(b.open.id);
  });

  it('answers what the repository found when things change between the check and the move', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    for (const [kind, status, name] of [['not-found', 404, 'not_found'], ['collection-deleted', 409, 'collection_deleted'], ['conflict', 409, 'conflict']] as const) {
      b.pages.move = () => Promise.resolve({ kind });
      const res = await move(b, page.id, { parentId: null });
      expect([res.status, await code(res)]).toEqual([status, name]);
    }
    b.pages.get = () => Promise.resolve(undefined);
    expect((await move(b, page.id, { parentId: null })).status).toBe(404);
  });
});

describe('DELETE /v1/pages/{id}', () => {
  it('is 403 to a reader without write and 404 to a user who cannot read', async () => {
    const b = build();
    const open = b.pages.seed({ collectionId: b.open.id });
    const hidden = b.pages.seed({ collectionId: b.closed.id });
    expect((await b.call('member', 'DELETE', `/v1/pages/${open.id}`)).status).toBe(403);
    expect((await b.call('outsider', 'DELETE', `/v1/pages/${hidden.id}`)).status).toBe(404);
    expect(b.pages.batchOf(open.id)).toBeUndefined();
  });

  it('deletes the page and its live descendants with the page id as the batch, keeps an earlier batch, and the pages are gone', async () => {
    const b = build();
    const top = b.pages.seed({ collectionId: b.shared.id });
    const kid = b.pages.seed({ collectionId: b.shared.id, parentId: top.id });
    const grandkid = b.pages.seed({ collectionId: b.shared.id, parentId: kid.id });
    const earlier = b.pages.seed({ collectionId: b.shared.id, parentId: top.id });
    const sibling = b.pages.seed({ collectionId: b.shared.id });
    expect((await b.call('member', 'DELETE', `/v1/pages/${earlier.id}`)).status).toBe(204);
    expect((await b.call('member', 'DELETE', `/v1/pages/${top.id}`)).status).toBe(204);
    expect([top, kid, grandkid].map((p) => b.pages.batchOf(p.id))).toEqual([top.id, top.id, top.id]);
    expect(b.pages.batchOf(earlier.id)).toBe(earlier.id);
    expect(b.pages.batchOf(sibling.id)).toBeUndefined();
    for (const p of [top, kid, grandkid]) expect((await b.call('admin', 'GET', `/v1/pages/${p.id}`)).status).toBe(404);
    expect((await b.call('member', 'DELETE', `/v1/pages/${top.id}`)).status).toBe(404);
    expect(b.pages.count()).toBe(5);
  });

  it('answers 404 when the page disappears between the check and the delete', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    b.pages.softDelete = () => Promise.resolve({ kind: 'not-found' });
    expect((await b.call('member', 'DELETE', `/v1/pages/${page.id}`)).status).toBe(404);
    b.pages.softDelete = () => Promise.resolve({ kind: 'conflict' });
    expect((await b.call('member', 'DELETE', `/v1/pages/${page.id}`)).status).toBe(409);
    b.pages.get = () => Promise.resolve(undefined);
    expect((await b.call('member', 'DELETE', `/v1/pages/${page.id}`)).status).toBe(404);
  });
});

describe('DELETE /v1/pages/{id} racing a move', () => {
  it('checks write access on the collection the page is in when the delete starts, and deletes nothing where the caller cannot write', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const get = b.pages.get.bind(b.pages);
    // After the page check another user moves the page into a collection the caller can only read.
    b.pages.get = async (id) => {
      await b.pages.move(id, { expectedCollectionId: b.shared.id, collectionId: b.open.id, parentId: null, afterId: null }, { maxDepth: 32, maxPages: 10_000 }, (x, y) => x ?? y ?? 'm');
      return get(id);
    };
    const res = await b.call('member', 'DELETE', `/v1/pages/${page.id}`);
    expect([res.status, await code(res)]).toEqual([403, 'forbidden']);
    expect(b.pages.batchOf(page.id)).toBeUndefined();
  });

  it('is a 409 and deletes nothing when the page leaves the checked collection after the check', async () => {
    const b = build();
    const page = b.pages.seed({ collectionId: b.shared.id });
    const original = b.pages.softDelete.bind(b.pages);
    b.pages.softDelete = async (id, by, expected) => {
      await b.pages.move(id, { expectedCollectionId: b.shared.id, collectionId: b.shared2.id, parentId: null, afterId: null }, { maxDepth: 32, maxPages: 10_000 }, (x, y) => x ?? y ?? 'm');
      return original(id, by, expected);
    };
    const res = await b.call('member', 'DELETE', `/v1/pages/${page.id}`);
    expect([res.status, await code(res)]).toEqual([409, 'conflict']);
    expect(b.pages.batchOf(page.id)).toBeUndefined();
  });
});

describe('POST /v1/pages with an empty editor state', () => {
  it('stores nothing: Markdown never goes in without its state', async () => {
    const b = build();
    b.converter.enqueueSeed({ ok: true, state: new Uint8Array(0) });
    const res = await make(b, { collectionId: b.shared.id, markdown: 'x' });
    expect(res.status).toBe(503);
    expect(b.pages.count()).toBe(0);
  });
});

/** The converter as the pool offers it, without a worker: the seed behind `seed`, the serialiser, the system rebuild. */
const inProcess: MarkdownConverter = {
  seed: (markdown) => seedInProcess(markdown),
  reseed: (markdown) => reseedInProcess(markdown),
  toMarkdown: (state) => convertInProcess(state),
  close: () => Promise.resolve(),
};
const FIXED_SEED_CLIENT = 3_000_000_000;
const clients = (state: Uint8Array): number[] => [...new Set(Y.decodeUpdate(state).structs.map((s) => s.id.client))];

describe('the state a page create stores (real seed)', () => {
  it('is not under the converter\'s fixed client id, and two creates from one text have different ids', async () => {
    const b = build(inProcess);
    const ids: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await make(b, { collectionId: b.shared.id, title: `T${String(i)}`, markdown: '# same\n\ntext' });
      expect(res.status).toBe(201);
      const stored = b.pages.stored(((await res.json()) as { id: string }).id)?.state;
      expect(stored).toBeDefined();
      ids.push(...clients(stored as Uint8Array));
    }
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(FIXED_SEED_CLIENT);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
