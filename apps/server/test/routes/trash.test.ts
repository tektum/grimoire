import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { admin: 'admin', member: 'member', reader: 'member', outsider: 'member' };
const DAY = 24 * 60 * 60 * 1000;

/** `shared` (the member writes), `open` (the member only reads), `closed` (nobody but administrators). */
function build(deleteFiles: (keys: readonly string[]) => Promise<void> = () => Promise.resolve()) {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = Object.entries(ROLES).map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000010${String(i)}`,
    descopeUserId: `d-${name}`,
    email: `${name}@example.com`,
    name,
    role,
    suspended: false, tenantId: 'legacy',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const shared = collections.seed({ name: 'Shared', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write' });
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a2', defaultPermission: 'read' });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a3', defaultPermission: null });
  const trash = new FakeTrashRepo(world);
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx,
    auth: { verifier },
    signInPolicy,
    http: {
      ...t.ctx.http,
      users,
      collections,
      trash,
      deleteFiles,
      idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store),
      authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string | undefined, method: string, url: string) => app.request(url, { method, headers: who === undefined ? {} : { authorization: `Bearer ${who}` } });
  return { app, call, trash, world, shared, open, closed, rows, now: t.clock.now() };
}

type Built = ReturnType<typeof build>;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const list = async (b: Built, who: string, query = '') => {
  const res = await b.call(who, 'GET', `/v1/trash${query}`);
  return {
    status: res.status,
    body: (await res.json()) as { items: { id: string; title: string; collectionId: string; deletedAt: number; deletedBy: string | null; daysLeft: number }[]; nextCursor: string | null },
  };
};

describe('GET /v1/trash', () => {
  it('lists one root per deleted batch, not its descendants, with the days left', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id, title: 'Root', deletedAt: b.now - 2 * DAY, deletedBy: b.rows[1]?.id as string });
    b.trash.seedDeleted({ collectionId: b.shared.id, title: 'Child', parentId: root, batch: root, deletedAt: b.now - 2 * DAY });
    const alone = b.trash.seedDeleted({ collectionId: b.shared.id, title: 'Alone', deletedAt: b.now - 29.5 * DAY });
    const out = await list(b, 'member');
    expect(out.status).toBe(200);
    expect(out.body.items.map((i) => [i.id, i.title, i.daysLeft])).toEqual([
      [root, 'Root', 28],
      [alone, 'Alone', 1],
    ]);
    expect(out.body.items[0]).toMatchObject({ collectionId: b.shared.id, deletedAt: b.now - 2 * DAY, deletedBy: b.rows[1]?.id });
  });

  it('shows a member only the collections they can write, and an administrator everything', async () => {
    const b = build();
    const mine = b.trash.seedDeleted({ collectionId: b.shared.id, title: 'mine' });
    b.trash.seedDeleted({ collectionId: b.open.id, title: 'read only' });
    b.trash.seedDeleted({ collectionId: b.closed.id, title: 'closed' });
    expect((await list(b, 'member')).body.items.map((i) => i.id)).toEqual([mine]);
    expect((await list(b, 'admin')).body.items).toHaveLength(3);
    expect((await list(b, 'outsider')).body.items.map((i) => i.id)).toEqual([mine]);
  });

  it('shows nothing, without asking the repository, to a caller who can write no collection', async () => {
    const b = build();
    b.trash.seedDeleted({ collectionId: b.shared.id });
    const shared = b.world.collections.find((c) => c.id === b.shared.id);
    if (shared) shared.defaultPermission = null; // the member now only reads `open`
    let asked = 0;
    const roots = b.trash.roots.bind(b.trash);
    b.trash.roots = (...args) => {
      asked += 1;
      return roots(...args);
    };
    const out = await list(b, 'member');
    expect([out.status, out.body]).toEqual([200, { items: [], nextCursor: null }]);
    expect(asked).toBe(0);
  });

  it('counts a batch that a collection delete made, for a caller who can write that collection', async () => {
    const b = build();
    const page = b.trash.seedDeleted({ collectionId: b.shared.id, title: 'Page of a deleted collection', batch: '00000000-0000-4000-8000-0000000000b1' });
    const col = b.world.collections.find((c) => c.id === b.shared.id);
    if (col) col.deleted = true;
    expect((await list(b, 'member')).body.items.map((i) => i.id)).toEqual([page]);
  });

  it('pages with a cursor, newest first, each root once', async () => {
    const b = build();
    const ids = [1, 2, 3, 4, 5].map((n) => b.trash.seedDeleted({ collectionId: b.shared.id, title: `p${String(n)}`, deletedAt: b.now - n * DAY }));
    const first = await list(b, 'member', '?limit=2');
    expect(first.body.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    const second = await list(b, 'member', `?limit=2&cursor=${first.body.nextCursor as string}`);
    const third = await list(b, 'member', `?limit=2&cursor=${second.body.nextCursor as string}`);
    expect([...second.body.items, ...third.body.items].map((i) => i.id)).toEqual([ids[2], ids[3], ids[4]]);
    expect(third.body.nextCursor).toBeNull();
    expect((await b.call('member', 'GET', '/v1/trash?cursor=nonsense')).status).toBe(422);
    const forged = (keys: unknown[]) => Buffer.from(JSON.stringify({ l: 'trash', k: keys }), 'utf8').toString('base64url');
    for (const keys of [
      ['x', 'y'],
      [1.5, ids[0]],
      [1000, 'not-a-uuid'],
      [1000, 7],
    ]) {
      const res = await b.call('member', 'GET', `/v1/trash?cursor=${forged(keys)}`);
      expect([res.status, await code(res)]).toEqual([422, 'invalid']);
    }
  });

  it('filters by collection: 404 for a collection the caller cannot read or only reads, the whole of it for a writer or an administrator', async () => {
    const b = build();
    const a = b.trash.seedDeleted({ collectionId: b.shared.id });
    b.trash.seedDeleted({ collectionId: b.open.id });
    b.trash.seedDeleted({ collectionId: b.closed.id });
    expect((await list(b, 'member', `?collectionId=${b.shared.id}`)).body.items.map((i) => i.id)).toEqual([a]);
    for (const hidden of [b.open.id, b.closed.id]) {
      const res = await b.call('member', 'GET', `/v1/trash?collectionId=${hidden}`);
      expect([res.status, await code(res)]).toEqual([404, 'not_found']);
    }
    expect((await list(b, 'admin', `?collectionId=${b.closed.id}`)).body.items).toHaveLength(1);
    expect((await b.call(undefined, 'GET', '/v1/trash')).status).toBe(401);
  });
});

describe('POST /v1/trash/{id}/restore', () => {
  it('restores the whole batch and returns the root', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id, title: 'Root' });
    const child = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: root, batch: root });
    const res = await b.call('member', 'POST', `/v1/trash/${root}/restore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: root, collectionId: b.shared.id, parentId: null, title: 'Root' });
    expect([b.trash.state(root), b.trash.state(child)]).toEqual(['live', 'live']);
    expect((await list(b, 'member')).body.items).toEqual([]);
  });

  it('puts a root whose parent was deleted at the top level, before the first live top-level page', async () => {
    const b = build();
    const first = b.trash.seedLive({ collectionId: b.shared.id, position: 'a5' });
    b.trash.seedLive({ collectionId: b.shared.id, position: 'a9' });
    const parent = b.trash.seedDeleted({ collectionId: b.shared.id });
    const root = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: parent });
    const res = await b.call('member', 'POST', `/v1/trash/${root}/restore`);
    const page = (await res.json()) as { parentId: string | null; position: string };
    expect(page.parentId).toBeNull();
    expect(page.position < 'a5').toBe(true);
    expect(b.trash.state(first)).toBe('live');
  });

  it('keeps a live parent, and the old place unless a live page has taken it', async () => {
    const b = build();
    const parent = b.trash.seedLive({ collectionId: b.shared.id, position: 'a1' });
    const free = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: parent, position: 'b1' });
    const kept = (await (await b.call('member', 'POST', `/v1/trash/${free}/restore`)).json()) as { parentId: string; position: string };
    expect(kept).toMatchObject({ parentId: parent, position: 'b1' });
    const taken = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: parent, position: 'b1' });
    const moved = (await (await b.call('member', 'POST', `/v1/trash/${taken}/restore`)).json()) as { parentId: string; position: string };
    expect(moved.parentId).toBe(parent);
    expect(moved.position > 'b1').toBe(true);
  });

  it('keeps the place of a top-level page when it is free, and sends a root to the top level when the batch would be too deep under its parent', async () => {
    const b = build();
    b.trash.seedLive({ collectionId: b.shared.id, position: 'a1' });
    const top = b.trash.seedDeleted({ collectionId: b.shared.id, position: 'a5' });
    expect(await (await b.call('member', 'POST', `/v1/trash/${top}/restore`)).json()).toMatchObject({ parentId: null, position: 'a5' });
    let tail = b.trash.seedLive({ collectionId: b.shared.id, position: 'c1' });
    for (let level = 2; level < 32; level++) tail = b.trash.seedLive({ collectionId: b.shared.id, parentId: tail });
    const root = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: tail });
    b.trash.seedDeleted({ collectionId: b.shared.id, parentId: root, batch: root });
    const deep = (await (await b.call('member', 'POST', `/v1/trash/${root}/restore`)).json()) as { parentId: string | null };
    expect(deep.parentId).toBeNull();
  });

  it('is 404 when the batch is purged between the checks and the restore', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    b.trash.beforeRestore = () => void b.trash.purge('legacy', root, b.rows[0]?.id as string, []); // an administrator purges it after the access check
    const res = await b.call('member', 'POST', `/v1/trash/${root}/restore`);
    expect([res.status, await code(res)]).toEqual([404, 'not_found']);
  });

  it('restores only into the collection that was checked: a page that moved after the check is 409 conflict and stays in the trash', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    b.trash.beforeRestore = () => b.trash.relocate(root, b.closed.id); // the page moves with a live ancestor after the access check
    const res = await b.call('member', 'POST', `/v1/trash/${root}/restore`);
    expect([res.status, await code(res)]).toEqual([409, 'conflict']);
    expect(b.trash.state(root)).toBe('deleted');
  });

  it('is 409 collection_deleted for a deleted collection, and 409 collection_full at 10,000 live pages', async () => {
    const b = build();
    const gone = b.trash.seedDeleted({ collectionId: b.shared.id, batch: '00000000-0000-4000-8000-0000000000b2' });
    const col = b.world.collections.find((c) => c.id === b.shared.id);
    if (col) col.deleted = true;
    const deleted = await b.call('member', 'POST', `/v1/trash/${gone}/restore`);
    expect([deleted.status, await code(deleted)]).toEqual([409, 'collection_deleted']);
    if (col) col.deleted = false;
    for (let n = 0; n < 10_000; n++) b.trash.seedLive({ collectionId: b.shared.id });
    const full = b.trash.seedDeleted({ collectionId: b.shared.id });
    const res = await b.call('member', 'POST', `/v1/trash/${full}/restore`);
    expect([res.status, await code(res)]).toEqual([409, 'collection_full']);
    expect(b.trash.state(full)).toBe('deleted');
  });

  it('is 404 to a caller who cannot read the collection, one who can only read it, an unknown id, a live page and a page that is not a root', async () => {
    const b = build();
    const hidden = b.trash.seedDeleted({ collectionId: b.closed.id });
    const readOnly = b.trash.seedDeleted({ collectionId: b.open.id });
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    const inner = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: root, batch: root });
    const live = b.trash.seedLive({ collectionId: b.shared.id });
    for (const [who, id] of [
      ['member', hidden],
      ['member', readOnly],
      ['outsider', hidden],
      ['member', '00000000-0000-4000-8000-000000000999'],
      ['member', live],
      ['member', inner],
    ] as const) {
      const res = await b.call(who, 'POST', `/v1/trash/${id}/restore`);
      expect([who, res.status, await code(res)]).toEqual([who, 404, 'not_found']);
    }
    expect([b.trash.state(hidden), b.trash.state(readOnly), b.trash.state(inner)]).toEqual(['deleted', 'deleted', 'deleted']);
    expect((await b.call(undefined, 'POST', `/v1/trash/${root}/restore`)).status).toBe(401);
  });
});

describe('DELETE /v1/trash/{id}', () => {
  it('purges the batch for an administrator: the files first, then the rows, one audit row', async () => {
    const asked: string[] = [];
    let rowsWhenAsked = '';
    const b = build((keys) => {
      asked.push(...keys);
      rowsWhenAsked = b.trash.state(root);
      return Promise.resolve();
    });
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    const child = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: root, batch: root, attachments: ['attachments/p/1/a.png'] });
    const res = await b.call('admin', 'DELETE', `/v1/trash/${root}`);
    expect(res.status).toBe(204);
    expect(asked).toEqual(['attachments/p/1/a.png']);
    expect(rowsWhenAsked).toBe('deleted');
    expect([b.trash.state(root), b.trash.state(child)]).toEqual(['gone', 'gone']);
    expect(b.trash.audit.events).toEqual([{ actorId: b.rows[0]?.id, action: 'page.purged', targetType: 'page', targetId: root, detail: { batch: root, pages: 2 }, tenantId: 'legacy' }]);
    expect((await b.call('admin', 'DELETE', `/v1/trash/${root}`)).status).toBe(404);
  });

  it('is 403 for anyone but an administrator, before any lookup: an unknown id is 403 too', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    for (const id of [root, '00000000-0000-4000-8000-000000000999']) {
      const res = await b.call('member', 'DELETE', `/v1/trash/${id}`);
      expect([res.status, await code(res)]).toEqual([403, 'forbidden']);
    }
    expect(b.trash.state(root)).toBe('deleted');
    expect((await b.call(undefined, 'DELETE', `/v1/trash/${root}`)).status).toBe(401);
  });

  it('is 404 for an administrator and an unknown id or a page that is not a root', async () => {
    const b = build();
    const root = b.trash.seedDeleted({ collectionId: b.shared.id });
    const inner = b.trash.seedDeleted({ collectionId: b.shared.id, parentId: root, batch: root });
    for (const id of ['00000000-0000-4000-8000-000000000999', inner]) expect((await b.call('admin', 'DELETE', `/v1/trash/${id}`)).status).toBe(404);
  });

  it('leaves every row in place and answers an error when the files cannot be removed', async () => {
    const b = build(() => Promise.reject(new Error('store down')));
    const root = b.trash.seedDeleted({ collectionId: b.shared.id, attachments: ['attachments/p/1/a.png'] });
    const res = await b.call('admin', 'DELETE', `/v1/trash/${root}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(b.trash.state(root)).toBe('deleted');
    expect(b.trash.audit.events).toEqual([]);
  });
});

describe('the trash routes in the document and in the source', () => {
  it('declare their policies', () => {
    const doc = build().app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } }) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(doc.paths['/v1/trash']?.['get']?.['x-grimoire-policy']).toEqual({ kind: 'authenticated' });
    const conflict = (doc.paths['/v1/trash/{id}/restore']?.['post']?.['responses'] as Record<string, { content?: Record<string, unknown> }>)['409'];
    expect(Object.keys(conflict?.content ?? {})).toEqual(['application/json']);
    expect(doc.paths['/v1/trash/{id}/restore']?.['post']?.['x-grimoire-policy']).toEqual({ kind: 'trash', param: 'id', need: 'write' });
    expect(doc.paths['/v1/trash/{id}']?.['delete']?.['x-grimoire-policy']).toEqual({ kind: 'admin' });
  });

  it('keep `includeDeleted` to routes/trash.ts, and `delete from pages` to the trash adapter', () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (['node_modules', 'dist', 'test'].includes(e.name) ? [] : files(path.join(dir, e.name))) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
      );
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    const sources = [...files(path.join(root, 'apps/server/src')), ...files(path.join(root, 'packages'))].filter((f) => f.includes('/src/') && !f.includes('/dist/'));
    expect(sources.filter((f) => /includeDeleted/.test(readFileSync(f, 'utf8')) && f.startsWith(path.join(root, 'apps/server/src'))).map(rel)).toEqual(['apps/server/src/routes/trash.ts']);
    expect(sources.filter((f) => /delete\s+from\s+pages\b|deleteFrom\(['"]pages['"]\)/i.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['packages/adapters/db-kysely/src/trash.ts']);
  });
});
