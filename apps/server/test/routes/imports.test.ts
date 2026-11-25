import { describe, expect, it, vi } from 'vitest';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { importFailedKey, importZipKey } from '../../src/import/keys.js';
import { makeContext } from '../server/support/context.js';

// The import routes (R6.39 to R6.43): who may see and change an import (the creator, an administrator of the same workspace, nobody of another), the zip's trip through the file
// store, one running import per workspace, the report with its cursor, the source of a failed page and cancel.
const PEOPLE: readonly { name: string; tenant: string; role: Role }[] = [
  { name: 'ada', tenant: 'T-a', role: 'member' },
  { name: 'bob', tenant: 'T-a', role: 'member' },
  { name: 'root', tenant: 'T-a', role: 'admin' },
  { name: 'eve', tenant: 'T-b', role: 'admin' },
];
const FILES: FilesConfig = {
  endpoint: 'http://s3.invalid',
  publicEndpoint: 'http://s3.invalid',
  publicOrigin: 'http://s3.invalid',
  bucket: 'b',
  accessKey: 'a',
  secretKey: 's',
  region: 'r',
  addressing: 'path',
  createOnlyHeader: 'if-none-match',
  corsMode: 'external',
  maxBytes: 1000,
  allowedTypes: ['text/plain'],
  pendingMaxPerUser: 3,
};
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(60).fill(7)]);

function build(options: { files?: boolean; enqueueFails?: boolean } = {}) {
  const t = makeContext();
  const world = emptyWorld();
  const rows: UserRecord[] = PEOPLE.map((p, i) => ({
    id: `00000000-0000-4000-8000-00000000060${String(i)}`,
    descopeUserId: `d-${p.name}`,
    email: `${p.name}@example.com`,
    name: p.name,
    role: p.role,
    suspended: false,
    tenantId: p.tenant,
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false, tenantId: r.tenantId as string });
  const verifier: AuthVerifier = {
    verify: (token) => {
      const row = rows.find((r) => `tok-${r.name}` === token);
      return Promise.resolve(row === undefined ? { kind: 'invalid-token' } : { kind: 'ok', userId: row.descopeUserId, expiresAt: 9e12, tenant: { kind: 'one', id: row.tenantId as string } });
    },
  };
  const users = new FakeUserStore(rows);
  const collections = new FakeCollectionRepo(world);
  const rw = collections.seed({ name: 'Docs', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write', tenantId: 'T-a' });
  const ro = collections.seed({ name: 'Handbook', description: null, icon: null, color: null, position: 'a2', defaultPermission: 'read', tenantId: 'T-a' });
  const theirs = collections.seed({ name: 'Theirs', description: null, icon: null, color: null, position: 'a1', defaultPermission: 'read_write', tenantId: 'T-b' });
  const store = createFakeAccessStore(world);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const imports = new FakeImportRepo();
  const files = new FakeFileStorage({ clock: t.clock });
  const config = { ...t.ctx.config, ...(options.files === false ? {} : { files: FILES }) };
  const enqueued: { name: string; payload: unknown; options: unknown }[] = [];
  const app = createApp({
    ...t.ctx,
    config,
    auth: { verifier },
    signInPolicy,
    http: {
      ...t.ctx.http,
      config,
      users,
      collections,
      audit: collections.audit,
      imports,
      ...(options.files === false ? {} : { files }),
      idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store),
      authorizer: createAuthorizer(store),
      enqueue: (name, payload, opts) => {
        if (options.enqueueFails === true) return Promise.reject(new Error('jobs-unavailable'));
        enqueued.push({ name, payload, options: opts });
        return Promise.resolve('job-1');
      },
    },
  });
  const call = (who: string | undefined, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { ...(who === undefined ? {} : { authorization: `Bearer tok-${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const uid = (name: string) => rows.find((r) => r.name === name)!.id;
  /** An import of ada's: made through the route, so that its key and size are the route's. */
  const made = async (over: object = {}, who = 'ada', collectionId = rw.id) => {
    const res = await call(who, 'POST', '/v1/imports', { collectionId, fileName: 'export.zip', size: ZIP.length, ...over });
    return { res, id: ((await res.clone().json()) as { id?: string }).id ?? '' };
  };
  const sent = async (id: string, tenant = 'T-a', bytes: Uint8Array = ZIP) => {
    await files.put(importZipKey(tenant, id), bytes, { size: bytes.length, contentType: 'application/zip' });
  };
  /** An import of ada's that has been sent and started. */
  const running = async () => {
    const { id } = await made();
    await sent(id);
    expect((await call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    return id;
  };
  return { call, made, sent, running, uid, imports, files, enqueued, collections, world, rw, ro, theirs, audit: collections.audit, clock: t.clock, logs: t.logger };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('POST /v1/imports', () => {
  it('makes an import and a signed PUT for the zip under the tenant, for at least 3,000 seconds, never cached', async () => {
    const t = build();
    const { res, id } = await t.made();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { id: string; upload: { method: string; headers: Record<string, string>; expiresAt: number } };
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/zip', 'if-none-match': '*' } });
    expect(body.upload.expiresAt - t.clock.now()).toBeGreaterThanOrEqual(3_000_000);
    expect(await t.imports.get('T-a', id)).toMatchObject({ status: 'created', createdBy: t.uid('ada'), targetCollectionId: t.rw.id, bytes: ZIP.length, s3Key: importZipKey('T-a', id), source: 'markdown_zip' });
  });

  it('refuses a zip above the largest an import takes (413), and a request that is not valid or has more in it than the contract has (422)', async () => {
    const t = build();
    expect(await code((await t.made({ size: 10 ** 12 })).res)).toBe('too_large');
    for (const over of [{ size: 0 }, { size: 1.5 }, { size: '10' }, { fileName: '' }, { collectionId: 'nope' }, { databaseMode: 'table' }]) {
      const { res } = await t.made(over);
      expect([res.status, await code(res)], JSON.stringify(over)).toEqual([422, 'invalid']);
    }
    expect(await code(await t.call('ada', 'POST', '/v1/imports', { collectionId: t.rw.id, fileName: 'a.zip' }))).toBe('invalid');
  });

  it('needs a collection the caller can write: one they can only read is 403, one of another workspace or unknown is 404, and nobody signed in is 401', async () => {
    const t = build();
    expect([(await t.made({}, 'ada', t.ro.id)).res.status]).toEqual([403]);
    expect((await t.made({}, 'ada', t.theirs.id)).res.status).toBe(404);
    expect((await t.made({}, 'ada', '00000000-0000-4000-8000-0000000000ff')).res.status).toBe(404);
    expect((await t.call(undefined, 'POST', '/v1/imports', { collectionId: t.rw.id, fileName: 'a.zip', size: 10 })).status).toBe(401);
    expect(t.imports.count()).toBe(0);
  });

  it('answers 503 when there is no file store, and makes no import', async () => {
    const t = build({ files: false });
    expect((await t.made()).res.status).toBe(503);
    expect(t.imports.count()).toBe(0);
  });

  it('allows ten in an hour for a person, then 429', async () => {
    const t = build();
    for (let n = 0; n < 10; n += 1) expect((await t.made()).res.status).toBe(201);
    const eleventh = (await t.made()).res;
    expect([eleventh.status, await code(eleventh)]).toEqual([429, 'rate_limited']);
    expect((await t.made({}, 'bob')).res.status).toBe(201);
  });
});

describe('POST /v1/imports/{id}/start', () => {
  it('runs a zip that arrived: 202, running, one job for this import of this tenant, one audit row', async () => {
    const t = build();
    const { id } = await t.made();
    await t.sent(id);
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([res.status, await res.json()]).toEqual([202, { status: 'running' }]);
    expect(await t.imports.get('T-a', id)).toMatchObject({ status: 'running' });
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: id, tenantId: 'T-a' }, options: { singletonKey: id } }]);
    expect(t.audit.events).toMatchObject([{ action: 'import.started', targetType: 'import', targetId: id, tenantId: 'T-a', actorId: t.uid('ada') }]);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('already_started');
    expect(t.enqueued).toHaveLength(1);
  });

  it('says what is wrong with the file: not sent (409 upload_missing), another size (409 size_mismatch), not a zip (422 not_a_zip); the import stays as it was', async () => {
    const t = build();
    const a = (await t.made()).id;
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${a}/start`))).toBe('upload_missing');
    const b = (await t.made()).id;
    await t.sent(b, 'T-a', new Uint8Array([0x50, 0x4b, 3, 4, 1]));
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${b}/start`))).toBe('size_mismatch');
    const c = (await t.made()).id;
    await t.sent(c, 'T-a', new Uint8Array(ZIP.length).fill(0x41));
    const bad = await t.call('ada', 'POST', `/v1/imports/${c}/start`);
    expect([bad.status, await code(bad)]).toEqual([422, 'not_a_zip']);
    for (const id of [a, b, c]) expect((await t.imports.get('T-a', id))?.status).toBe('created');
    expect(t.enqueued).toEqual([]);
  });

  it("is the creator's alone: another person, an administrator of the workspace and an administrator of another are all 404", async () => {
    const t = build();
    const { id } = await t.made();
    await t.sent(id);
    for (const who of ['bob', 'root', 'eve']) expect((await t.call(who, 'POST', `/v1/imports/${id}/start`)).status, who).toBe(404);
    expect((await t.call('ada', 'POST', '/v1/imports/00000000-0000-4000-8000-0000000000ff/start')).status).toBe(404);
    expect((await t.imports.get('T-a', id))?.status).toBe('created');
  });

  it('is 404 for a person who can no longer write in the collection, 403 never', async () => {
    const t = build();
    const { id } = await t.made();
    await t.sent(id);
    t.world.collections.find((c) => c.id === t.rw.id)!.defaultPermission = 'read';
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(404);
    expect((await t.imports.get('T-a', id))?.status).toBe('created');
  });

  it('lets one import of a workspace run at a time: the second start is 409 already_running and waits as it was, and can start when the first has ended', async () => {
    const t = build();
    const first = await t.running();
    const second = (await t.made()).id;
    await t.sent(second);
    const refused = await t.call('ada', 'POST', `/v1/imports/${second}/start`);
    expect([refused.status, await code(refused)]).toEqual([409, 'already_running']);
    expect((await t.imports.get('T-a', second))?.status).toBe('uploaded');
    expect(t.enqueued).toHaveLength(1);
    expect((await t.call('ada', 'POST', `/v1/imports/${first}/cancel`)).status).toBe(200);
    expect((await t.call('ada', 'POST', `/v1/imports/${second}/start`)).status).toBe(202);
  });

  it('two starts at once leave one running and one 409 already_running', async () => {
    const t = build();
    const a = (await t.made()).id;
    const b = (await t.made()).id;
    await t.sent(a);
    await t.sent(b);
    const results = await Promise.all([t.call('ada', 'POST', `/v1/imports/${a}/start`), t.call('ada', 'POST', `/v1/imports/${b}/start`)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(t.enqueued).toHaveLength(1);
  });

  it('answers 503 and gives the import back when the job cannot be queued, so that the start can be tried again', async () => {
    const t = build({ enqueueFails: true });
    const { id } = await t.made();
    await t.sent(id);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(503);
    expect((await t.imports.get('T-a', id))?.status).toBe('uploaded');
    expect(t.audit.events).toEqual([]);
  });
});

describe('the start, where the store or the repository does not do what is expected', () => {
  const sendAndStart = async (t: ReturnType<typeof build>) => {
    const { id } = await t.made();
    await t.sent(id);
    return id;
  };

  it('answers 503 when the file store does not answer (creating, starting, the report and the source), and so is any other failure, as the server answers every one it did not expect', async () => {
    const t = build();
    const down = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    vi.spyOn(t.files, 'signUpload').mockImplementationOnce(down);
    expect((await t.made()).res.status).toBe(503);
    const id = await sendAndStart(t);
    vi.spyOn(t.files, 'head').mockImplementationOnce(down);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(503);
    vi.spyOn(t.files, 'head').mockImplementationOnce(() => Promise.reject(new Error('boom')));
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(503);
    expect((await t.imports.get('T-a', id))?.status).toBe('created');
    // The report and the source with a store that fails.
    t.imports.seed({ id: '00000000-0000-4000-8000-0000000000b1', tenantId: 'T-a', status: 'done', createdBy: t.uid('ada'), targetCollectionId: t.rw.id });
    await t.imports.addItems('T-a', '00000000-0000-4000-8000-0000000000b1', [{ path: 'a.md', kind: 'page' }]);
    const [item] = await t.imports.pending('T-a', '00000000-0000-4000-8000-0000000000b1', 'page', 1);
    await t.imports.settle('T-a', '00000000-0000-4000-8000-0000000000b1', item!.id, { status: 'failed', message: 'content-lost' });
    vi.spyOn(t.files, 'head').mockImplementation(down);
    expect((await t.call('ada', 'GET', '/v1/imports/00000000-0000-4000-8000-0000000000b1/items')).status).toBe(503);
    expect((await t.call('ada', 'GET', `/v1/imports/00000000-0000-4000-8000-0000000000b1/items/${item!.id}/source`)).status).toBe(503);
  });

  it('is 404 when the collection the import is for is gone, and does not need the key stored on the row', async () => {
    const t = build();
    const gone = '00000000-0000-4000-8000-0000000000c1';
    t.imports.seed({ id: gone, tenantId: 'T-a', status: 'uploaded', createdBy: t.uid('ada'), targetCollectionId: '00000000-0000-4000-8000-0000000000ff', bytes: ZIP.length });
    expect((await t.call('ada', 'POST', `/v1/imports/${gone}/start`)).status).toBe(404);
    const keyless = '00000000-0000-4000-8000-0000000000c2';
    t.imports.seed({ id: keyless, tenantId: 'T-a', status: 'uploaded', createdBy: t.uid('ada'), targetCollectionId: t.rw.id, bytes: ZIP.length });
    await t.sent(keyless);
    expect((await t.call('ada', 'POST', `/v1/imports/${keyless}/start`)).status).toBe(202);
  });

  it('is 409 upload_missing when the zip is gone between the look and the read of its first bytes', async () => {
    const t = build();
    const id = await sendAndStart(t);
    vi.spyOn(t.files, 'get').mockImplementationOnce(() => Promise.reject(new FileStorageError('not-found', 'gone')));
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('upload_missing');
  });

  it('is 409 already_started when another start got there first, whether it moved the row before or after this one looked', async () => {
    const t = build();
    const id = await sendAndStart(t);
    vi.spyOn(t.imports, 'markUploaded').mockResolvedValueOnce(false);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('already_started');
    vi.spyOn(t.imports, 'begin').mockResolvedValueOnce({ kind: 'not-uploaded' });
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('already_started');
    expect(t.enqueued).toEqual([]);
  });
});

describe('GET /v1/imports/{id}', () => {
  it('tells the creator and an administrator of the workspace where the import is, without the warnings, and nobody else', async () => {
    const t = build();
    const id = await t.running();
    await t.imports.setCounts('T-a', id, { pagesTotal: 10, pagesDone: 4, attachments: 2, skipped: 1, failed: 1, warnings: 5 });
    for (const who of ['ada', 'root']) {
      const res = await t.call(who, 'GET', `/v1/imports/${id}`);
      expect(res.status, who).toBe(200);
      expect(await res.json()).toEqual({
        status: 'running',
        counts: { pagesTotal: 10, pagesDone: 4, attachments: 2, skipped: 1, failed: 1 },
        startedAt: new Date(t.clock.now()).toISOString(),
        finishedAt: null,
        error: null,
      });
    }
    for (const who of ['bob', 'eve']) expect((await t.call(who, 'GET', `/v1/imports/${id}`)).status, who).toBe(404);
    expect((await t.call('ada', 'GET', '/v1/imports/00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });
});

describe('GET /v1/imports/{id}/items', () => {
  async function withReport() {
    const t = build();
    const id = await t.running();
    await t.imports.addItems('T-a', id, [
      { path: 'a.md', kind: 'page' },
      { path: 'b.md', kind: 'page' },
      { path: 'img/c.png', kind: 'attachment' },
      { path: 'd.md', kind: 'page' },
      { path: 'e.md', kind: 'page' },
    ]);
    const items = await t.imports.pending('T-a', id, 'page', 10);
    const attachment = await t.imports.pending('T-a', id, 'attachment', 10);
    await t.imports.settle('T-a', id, items[0]!.id, { status: 'failed', message: 'content-lost', markdownBytes: 10, stateBytes: 20 });
    await t.imports.settle('T-a', id, items[1]!.id, { status: 'skipped', message: 'too_large' });
    await t.imports.settle('T-a', id, attachment[0]!.id, { status: 'failed', message: 'type_mismatch' });
    return { t, id, items, attachment };
  }

  it("lists the settled files in id order with the contract's fields, and leaves the ones still waiting out", async () => {
    const { t, id, items } = await withReport();
    const res = await t.call('ada', 'GET', `/v1/imports/${id}/items`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((i) => [i['path'], i['status'], i['message'], i['kind'], i['hasSource']])).toEqual([
      ['a.md', 'failed', 'content-lost', 'page', false],
      ['b.md', 'skipped', 'too_large', 'page', false],
      ['img/c.png', 'failed', 'type_mismatch', 'attachment', false],
    ]);
    expect(body.items[0]).toMatchObject({ id: items[0]!.id, pageId: null, markdownBytes: 10, stateBytes: 20 });
    expect(Object.keys(body.items[0]!).sort()).toEqual(['hasSource', 'id', 'kind', 'markdownBytes', 'message', 'pageId', 'path', 'stateBytes', 'status']);
  });

  it('says a failed page has a source only when its original was kept', async () => {
    const { t, id, items } = await withReport();
    await t.files.put(importFailedKey('T-a', id, items[0]!.id), new Uint8Array([35, 32]), { size: 2, contentType: 'text/markdown' });
    const body = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items`)).json()) as { items: { path: string; hasSource: boolean }[] };
    expect(body.items.map((i) => [i.path, i.hasSource])).toEqual([
      ['a.md', true],
      ['b.md', false],
      ['img/c.png', false],
    ]);
  });

  it('pages with a cursor of its own, and refuses one that this list did not issue (422)', async () => {
    const { t, id } = await withReport();
    const first = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items?limit=2`)).json()) as { items: { path: string }[]; nextCursor: string };
    expect(first.items.map((i) => i.path)).toEqual(['a.md', 'b.md']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items?limit=2&cursor=${first.nextCursor}`)).json()) as { items: { path: string }[]; nextCursor: string | null };
    expect(second).toEqual({ items: [expect.objectContaining({ path: 'img/c.png' })], nextCursor: null });
    for (const bad of ['nonsense', Buffer.from(JSON.stringify({ l: 'trash', k: ['1'] })).toString('base64url'), Buffer.from(JSON.stringify({ l: 'import-items', k: ['1; drop'] })).toString('base64url')]) {
      expect((await t.call('ada', 'GET', `/v1/imports/${id}/items?cursor=${bad}`)).status, bad).toBe(422);
    }
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items?limit=0`)).status).toBe(422);
  });

  it('cuts a path to 300 characters and takes the control characters out of it', async () => {
    const t = build();
    const id = await t.running();
    const odd = `docs/${'x'.repeat(400)}\u0007\u202e.md`;
    await t.imports.addItems('T-a', id, [{ path: odd, kind: 'page' }]);
    const [item] = await t.imports.pending('T-a', id, 'page', 1);
    await t.imports.settle('T-a', id, item!.id, { status: 'failed', message: 'bad_name' });
    const body = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items`)).json()) as { items: { path: string }[] };
    expect(body.items[0]!.path).toHaveLength(300);
    expect(body.items[0]!.path).not.toContain('\u0007');
    expect((await t.imports.getItem('T-a', id, item!.id))?.path).toBe(odd);
  });

  it("is the creator's and the workspace administrator's only", async () => {
    const { t, id } = await withReport();
    expect((await t.call('root', 'GET', `/v1/imports/${id}/items`)).status).toBe(200);
    for (const who of ['bob', 'eve']) expect((await t.call(who, 'GET', `/v1/imports/${id}/items`)).status, who).toBe(404);
  });
});

describe('GET /v1/imports/{id}/items/{itemId}/source', () => {
  async function failedPage() {
    const t = build();
    const id = await t.running();
    await t.imports.addItems('T-a', id, [
      { path: 'notes/broken page.md', kind: 'page' },
      { path: 'ok.md', kind: 'page' },
    ]);
    const pending = await t.imports.pending('T-a', id, 'page', 2);
    const broken = pending.find((i) => i.path === 'notes/broken page.md');
    const other = pending.find((i) => i.path === 'ok.md');
    await t.imports.settle('T-a', id, broken!.id, { status: 'failed', message: 'content-lost' });
    await t.imports.settle('T-a', id, other!.id, { status: 'skipped', message: 'empty' });
    return { t, id, broken: broken!, other: other! };
  }

  it('gives a short-lived download address for the kept original of a failed page, as an attachment', async () => {
    const { t, id, broken } = await failedPage();
    await t.files.put(importFailedKey('T-a', id, broken.id), new Uint8Array([35]), { size: 1, contentType: 'text/markdown' });
    const sign = vi.spyOn(t.files, 'signDownload');
    const res = await t.call('ada', 'GET', `/v1/imports/${id}/items/${broken.id}/source`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { url: string; expiresAt: number };
    expect(body.expiresAt - t.clock.now()).toBeLessThanOrEqual(300_000);
    expect(sign).toHaveBeenCalledWith(
      importFailedKey('T-a', id, broken.id),
      expect.objectContaining({ disposition: 'attachment', contentType: 'application/octet-stream', fileName: expect.stringContaining('broken') as string }),
    );
    expect(body.url).toEqual(expect.any(String));
    expect((await t.call('root', 'GET', `/v1/imports/${id}/items/${broken.id}/source`)).status).toBe(200);
  });

  it("is 404 for a file that did not fail, one with no kept original, another import's item, another person and another workspace", async () => {
    const { t, id, broken, other } = await failedPage();
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/${broken.id}/source`)).status, 'no original kept').toBe(404);
    await t.files.put(importFailedKey('T-a', id, broken.id), new Uint8Array([35]), { size: 1, contentType: 'text/markdown' });
    await t.files.put(importFailedKey('T-a', id, other.id), new Uint8Array([35]), { size: 1, contentType: 'text/markdown' });
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/${other.id}/source`)).status, 'skipped, not failed').toBe(404);
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/99999/source`)).status, 'no such item').toBe(404);
    for (const who of ['bob', 'eve']) expect((await t.call(who, 'GET', `/v1/imports/${id}/items/${broken.id}/source`)).status, who).toBe(404);
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/abc/source`)).status, 'not an item id').toBe(422);
  });

  it('answers 503 when there is no file store', async () => {
    const t = build({ files: false });
    const id = '00000000-0000-4000-8000-0000000000aa';
    t.imports.seed({ id, tenantId: 'T-a', status: 'done', createdBy: t.uid('ada'), targetCollectionId: t.rw.id });
    await t.imports.addItems('T-a', id, [{ path: 'a.md', kind: 'page' }]);
    const [item] = await t.imports.pending('T-a', id, 'page', 1);
    await t.imports.settle('T-a', id, item!.id, { status: 'failed', message: 'content-lost' });
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/${item!.id}/source`)).status).toBe(503);
    const items = await t.call('ada', 'GET', `/v1/imports/${id}/items`);
    expect(items.status, 'the report itself needs no store: no source is offered').toBe(200);
    expect(((await items.json()) as { items: { hasSource: boolean }[] }).items.map((i) => i.hasSource)).toEqual([false]);
  });
});

describe('POST /v1/imports/{id}/cancel', () => {
  it('cancels a running import for its creator or an administrator of the workspace, and says so in the audit trail', async () => {
    const t = build();
    const id = await t.running();
    const res = await t.call('root', 'POST', `/v1/imports/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', finishedAt: new Date(t.clock.now()).toISOString() });
    expect(t.audit.events.map((e) => e.action)).toEqual(['import.started', 'import.cancelled']);
    expect(t.audit.events[1]).toMatchObject({ actorId: t.uid('root'), targetId: id, tenantId: 'T-a' });
  });

  it('is 409 not_running when it is not running (not started, ended, or cancelled already), and 404 for anyone who may not see it', async () => {
    const t = build();
    const { id } = await t.made();
    const early = await t.call('ada', 'POST', `/v1/imports/${id}/cancel`);
    expect([early.status, await code(early)]).toEqual([409, 'not_running']);
    const running = await t.running();
    expect((await t.call('ada', 'POST', `/v1/imports/${running}/cancel`)).status).toBe(200);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${running}/cancel`))).toBe('not_running');
    const other = await t.running();
    for (const who of ['bob', 'eve']) expect((await t.call(who, 'POST', `/v1/imports/${other}/cancel`)).status, who).toBe(404);
    expect((await t.imports.get('T-a', other))?.status).toBe('running');
  });
});
