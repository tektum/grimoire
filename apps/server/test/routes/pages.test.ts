import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
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
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read' });
  const shared = collections.seed({ name: 'Shared', description: null, icon: null, color: null, position: 'a2', defaultPermission: 'read_write' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a3', defaultPermission: null });
  const pages = new FakePageRepo(world);
  const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown: 'canonical', text: 'canonical' } });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, users, collections, pages, converter, idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, pages, collections, converter, world, open, shared, closed, rows };
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
    expect(b.pages.stored(page.id)).toEqual({ markdown: 'canonical', state: new Uint8Array([1, 2, 3]) });
  });

  it('stores no Markdown and no state for a page created without it', async () => {
    const b = build();
    const page = await meta(await make(b, { collectionId: b.shared.id }));
    expect(b.pages.stored(page.id)).toEqual({ markdown: null, state: null });
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
