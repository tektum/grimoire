import { describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

const ROLES: Record<string, Role> = { writer: 'member', reader: 'member', outsider: 'member', other: 'member' };
const NIL = '00000000-0000-4000-8000-000000000000';
const FILES: FilesConfig = {
  endpoint: 'http://s3.invalid', publicEndpoint: 'http://s3.invalid', publicOrigin: 'http://s3.invalid', bucket: 'b', accessKey: 'a', secretKey: 's', region: 'r',
  addressing: 'path', createOnlyHeader: 'if-none-match', corsMode: 'external', maxBytes: 1000, allowedTypes: ['image/png', 'application/pdf', 'text/plain'], pendingMaxPerUser: 3,
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** Four people. `rw` lets everyone write, `ro` lets everyone read, `closed` lets nobody but the owner list in. */
function build(options: { files?: boolean } = {}) {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = Object.entries(ROLES).map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000010${String(i)}`, descopeUserId: `d-${name}`, email: `${name}@example.com`, name, role, suspended: false, tenantId: 'legacy',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  world.collections.push({ id: 'c-rw', deleted: false, defaultPermission: 'read_write' }, { id: 'c-ro', deleted: false, defaultPermission: 'read' }, { id: 'c-closed', deleted: false, defaultPermission: null });
  const pageIn = (n: string, collectionId: string): string => {
    const id = `00000000-0000-4000-8000-0000000002${n}`;
    world.pages.push({ id, collectionId, deleted: false, epoch: 0 });
    return id;
  };
  const rw = pageIn('01', 'c-rw'); const ro = pageIn('02', 'c-ro'); const closed = pageIn('03', 'c-closed');
  const store = createFakeAccessStore(world);
  const attachments = new FakeAttachmentRepo({ pages: (id) => world.pages.some((p) => p.id === id) });
  const files = new FakeFileStorage({ clock: t.clock });
  const config = { ...t.ctx.config, ...(options.files === false ? {} : { files: FILES }) };
  const idRows = rows.map((r) => r.id);
  const app = createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, attachments, ...(options.files === false ? {} : { files }), idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }), access: createPageAccess(store), authorizer: createAuthorizer(store),
    },
  });
  const send = (who: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { ...(who === undefined ? {} : { authorization: `Bearer ${who}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const meta = (pageId: string, over: object = {}) => ({ pageId, fileName: 'a.png', contentType: 'image/png', size: PNG.length, ...over });
  const create = (who: string, pageId: string, over: object = {}, headers: Record<string, string> = {}) => send(who, 'POST', '/v1/attachments', meta(pageId, over), headers);
  /** A created and uploaded attachment, not yet completed. */
  const uploaded = async (who: string, pageId: string, bytes: Uint8Array = PNG, over: object = {}) => {
    const res = await create(who, pageId, { size: bytes.length, ...over });
    const body = (await res.json()) as { id: string };
    await files.put((await attachments.get(body.id))!.key, bytes, { size: bytes.length, contentType: 'image/png' });
    return body.id;
  };
  return { send, create, uploaded, meta, rw, ro, closed, world, attachments, files, logs: t.logger, clock: t.clock, uid: (name: string) => idRows[Object.keys(ROLES).indexOf(name)] as string };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('POST /v1/attachments', () => {
  it('creates a pending attachment: 201, a signed PUT, the Markdown path, never cached', async () => {
    const t = build();
    const res = await t.create('writer', t.rw);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { id: string; upload: { method: string; url: string; headers: Record<string, string>; expiresAt: number }; markdownPath: string };
    expect(body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png', 'if-none-match': '*' } });
    expect(body.upload.expiresAt).toBe(t.clock.now() + 600_000);
    expect(body.markdownPath).toBe(`attachments/${body.id}/a.png`);
    expect(await t.attachments.get(body.id)).toMatchObject({ status: 'pending', pageId: t.rw, uploaderId: t.uid('writer'), size: PNG.length });
  });

  it('refuses a type that is not allowed (422), a size that is too large (413), and a size that is not positive (422)', async () => {
    const t = build();
    const refused = async (over: object) => { const r = await t.create('writer', t.rw, over); return [r.status, await code(r)]; };
    expect(await refused({ contentType: 'image/svg+xml', size: 10 ** 9 })).toEqual([422, 'type_not_allowed']);
    expect(await refused({ size: 1001 })).toEqual([413, 'too_large']);
    expect(await refused({ size: 0 })).toEqual([422, 'invalid']);
    expect(await refused({ size: 1.5 })).toEqual([422, 'invalid']);
    expect(t.attachments.all()).toEqual([]);
  });

  it('answers 429 rate_limited at the user\'s cap of pending uploads', async () => {
    const t = build();
    for (let i = 0; i < 3; i += 1) expect((await t.create('writer', t.rw)).status).toBe(201);
    const fourth = await t.create('writer', t.rw);
    expect([fourth.status, await code(fourth)]).toEqual([429, 'rate_limited']);
    expect((await t.create('other', t.rw)).status).toBe(201); // the cap is the user's own
  });

  it('401 without a token, 403 to a reader of the page, 404 to a user who cannot read it, 404 for an unknown page', async () => {
    const t = build();
    expect((await t.send(undefined, 'POST', '/v1/attachments', t.meta(t.rw))).status).toBe(401);
    expect((await t.create('reader', t.ro)).status).toBe(403);
    expect((await t.create('reader', t.closed)).status).toBe(404);
    expect((await t.create('writer', NIL)).status).toBe(404);
    expect(t.attachments.all()).toEqual([]);
  });

  it('answers 429 on the 26th call in 60 seconds', async () => {
    const t = build();
    for (let i = 0; i < 25; i += 1) await t.create('writer', t.rw, { size: 0 });
    expect((await t.create('writer', t.rw, { size: 0 })).status).toBe(429);
  });

  it('is 503 when the store is not configured, after the page is checked, and says so in the log without a key', async () => {
    const t = build({ files: false });
    const res = await t.create('writer', t.rw);
    expect([res.status, await code(res)]).toEqual([503, 'unavailable']);
    expect((await t.create('reader', t.closed)).status).toBe(404);
  });

  it('is 503 when the store cannot sign, and leaves no pending row behind', async () => {
    const t = build();
    t.files.signUpload = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    expect((await t.create('writer', t.rw)).status).toBe(503);
    expect(t.attachments.all()).toEqual([]);
  });

  it('turns a refusal of the repository into 404 (page or user gone since the check) and passes other errors on', async () => {
    const gone = build();
    gone.attachments.createPending = () => Promise.resolve({ kind: 'no-page' });
    expect((await gone.create('writer', gone.rw)).status).toBe(404);
    gone.attachments.createPending = () => Promise.resolve({ kind: 'no-user' });
    expect((await gone.create('writer', gone.rw)).status).toBe(404);
    gone.attachments.createPending = () => Promise.reject(new Error('boom'));
    expect((await gone.create('writer', gone.rw)).status).toBe(503); // anything unexpected is the generic 503, with no detail
  });
});

describe('an Idempotency-Key on POST /v1/attachments', () => {
  const key = { 'idempotency-key': 'k-1' };

  it('replays with a freshly signed URL, the same id and Markdown path, and Idempotent-Replay', async () => {
    const t = build();
    const first = (await (await t.create('writer', t.rw, {}, key)).json()) as { id: string; upload: { url: string }; markdownPath: string };
    const res = await t.create('writer', t.rw, {}, key);
    expect([res.status, res.headers.get('idempotent-replay'), res.headers.get('cache-control')]).toEqual([201, 'true', 'no-store']);
    const again = (await res.json()) as typeof first;
    expect([again.id, again.markdownPath]).toEqual([first.id, first.markdownPath]);
    expect(again.upload.url).not.toBe(first.upload.url);
    expect(t.attachments.all()).toHaveLength(1);
  });

  it('signs the replayed upload for no longer than the row has left', async () => {
    const t = build();
    await t.create('writer', t.rw, {}, key);
    t.clock.advance(3_600_000 - 90_000);
    const again = (await (await t.create('writer', t.rw, {}, key)).json()) as { upload: { expiresAt: number } };
    expect(again.upload.expiresAt).toBe(t.clock.now() + 90_000);
  });

  it('is 409 conflict once the upload expired, completed, or was removed, and 404 when the caller cannot write the page any more', async () => {
    const t = build();
    const id = ((await (await t.create('writer', t.rw, {}, key)).json()) as { id: string }).id;
    t.clock.advance(3_600_001);
    const expired = await t.create('writer', t.rw, {}, key);
    expect([expired.status, await code(expired)]).toEqual([409, 'conflict']);
    await t.attachments.remove(id);
    expect((await t.create('writer', t.rw, {}, key)).status).toBe(409);
    const lost = build();
    await lost.create('writer', lost.rw, {}, key);
    lost.world.pages[0]!.deleted = true;
    expect((await lost.create('writer', lost.rw, {}, key)).status).toBe(404);
  });

  it('is 503 on a replay when the store is gone', async () => {
    const t = build();
    await t.create('writer', t.rw, {}, key);
    t.files.signUpload = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    expect((await t.create('writer', t.rw, {}, key)).status).toBe(503);
  });
});

describe('POST /v1/attachments/{id}/complete', () => {
  const complete = (t: ReturnType<typeof build>, who: string, id: string) => t.send(who, 'POST', `/v1/attachments/${id}/complete`);

  it('makes the upload ready after the bytes arrived: 200 with the attachment, and the same answer when called again', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw);
    const res = await complete(t, 'writer', id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ id, pageId: t.rw, fileName: 'a.png', contentType: 'image/png', size: PNG.length, markdownPath: `attachments/${id}/a.png` });
    expect((await t.attachments.get(id))?.status).toBe('ready');
    expect((await complete(t, 'writer', id)).status).toBe(200);
  });

  it('is 409 upload_missing without the bytes, and 409 size_mismatch with other bytes; both discard the upload', async () => {
    const t = build();
    const created = (await (await t.create('writer', t.rw)).json()) as { id: string };
    const missing = await complete(t, 'writer', created.id);
    expect([missing.status, await code(missing)]).toEqual([409, 'upload_missing']);
    expect(await t.attachments.get(created.id)).toBeUndefined();
    const id = await t.uploaded('writer', t.rw, PNG.slice(0, 10), { size: PNG.length });
    const wrong = await complete(t, 'writer', id);
    expect([wrong.status, await code(wrong)]).toEqual([409, 'size_mismatch']);
    expect(await t.attachments.get(id)).toBeUndefined();
    await expect(t.files.head(`tenants/legacy/attachments/${id}`)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('is 422 type_mismatch for bytes that are not the declared image, deleting object and row, and not for a type that is not checked', async () => {
    const t = build();
    const text = new TextEncoder().encode('not a png at all, just text');
    const id = await t.uploaded('writer', t.rw, text);
    const res = await complete(t, 'writer', id);
    expect([res.status, await code(res)]).toEqual([422, 'type_mismatch']);
    expect(await t.attachments.get(id)).toBeUndefined();
    await expect(t.files.head(`tenants/legacy/attachments/${id}`)).rejects.toMatchObject({ kind: 'not-found' });
    const plain = await t.uploaded('writer', t.rw, text, { fileName: 'n.txt', contentType: 'text/plain' });
    expect((await complete(t, 'writer', plain)).status).toBe(200);
  });

  it('is 404 to another user, for an unknown id, for an expired upload, and after the page went away or stopped being writable; the row stays', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw);
    expect((await complete(t, 'other', id)).status).toBe(404);
    expect((await complete(t, 'writer', NIL)).status).toBe(404);
    t.world.collections[0]!.defaultPermission = 'read';
    expect((await complete(t, 'writer', id)).status).toBe(404);
    t.world.collections[0]!.defaultPermission = 'read_write';
    t.world.pages[0]!.deleted = true;
    expect((await complete(t, 'writer', id)).status).toBe(404);
    expect((await t.attachments.get(id))?.status).toBe('pending');
    t.world.pages[0]!.deleted = false;
    t.clock.advance(3_600_001);
    expect((await complete(t, 'writer', id)).status).toBe(404);
  });

  it('is 404 when the upload expires between the check and the update, and 503 when the store does not answer', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw);
    const markReady = t.attachments.markReady.bind(t.attachments);
    t.attachments.markReady = async (rowId, now) => { t.clock.advance(3_600_001); return markReady(rowId, now + 3_600_001); };
    expect((await complete(t, 'writer', id)).status).toBe(404);
    const down = build();
    const other = await down.uploaded('writer', down.rw);
    down.files.head = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    expect((await complete(down, 'writer', other)).status).toBe(503);
    expect((await down.attachments.get(other))?.status).toBe('pending');
  });

  it('is 503 when the store is not configured', async () => {
    const t = build({ files: false });
    expect((await complete(t, 'writer', NIL)).status).toBe(503);
  });
});

describe('GET /v1/attachments/{id}', () => {
  const link = (t: ReturnType<typeof build>, who: string, id: string, query = '') => t.send(who, 'GET', `/v1/attachments/${id}${query}`);
  const ready = async (t: ReturnType<typeof build>, page: string, over: object = {}) => {
    const id = await t.uploaded('writer', page, PNG, over);
    await t.send('writer', 'POST', `/v1/attachments/${id}/complete`);
    return id;
  };

  it('gives a 5-minute link to a ready attachment, shown inline for an image, as an attachment when a download is asked for; never cached', async () => {
    const t = build();
    const id = await ready(t, t.rw);
    const res = await link(t, 'reader', id);
    expect([res.status, res.headers.get('cache-control'), res.headers.get('referrer-policy')]).toEqual([200, 'no-store', 'no-referrer']);
    expect(((await res.json()) as { expiresAt: number }).expiresAt).toBe(t.clock.now() + 300_000);
    expect(t.files.signed.at(-1)).toMatchObject({ kind: 'download', disposition: 'inline', contentType: 'image/png' });
    await link(t, 'reader', id, '?download=true');
    expect(t.files.signed.at(-1)).toMatchObject({ disposition: 'attachment', contentType: 'image/png' });
    await link(t, 'reader', id, '?download=false');
    expect(t.files.signed.at(-1)).toMatchObject({ disposition: 'inline' });
  });

  it('serves a type that is not an image as an attachment of type application/octet-stream, whatever was asked', async () => {
    const t = build();
    const id = await ready(t, t.rw, { fileName: 'n.txt', contentType: 'text/plain' });
    await link(t, 'reader', id);
    expect(t.files.signed.at(-1)).toMatchObject({ disposition: 'attachment', contentType: 'application/octet-stream', fileName: 'n.txt' });
  });

  it('is 404 for a pending attachment, an unknown id, a page the caller cannot read, and an object that is gone; 401 without a token', async () => {
    const t = build();
    const pending = await t.uploaded('writer', t.rw);
    expect((await link(t, 'writer', pending)).status).toBe(404);
    expect((await link(t, 'writer', NIL)).status).toBe(404);
    const id = await ready(t, t.rw);
    t.world.pages[0]!.deleted = true;
    expect((await link(t, 'reader', id)).status).toBe(404);
    t.world.pages[0]!.deleted = false;
    await t.files.delete(`tenants/legacy/attachments/${id}`);
    expect((await link(t, 'reader', id)).status).toBe(404);
    expect((await t.send(undefined, 'GET', `/v1/attachments/${id}`)).status).toBe(401);
  });

  it('is 503 when the store does not answer or is not configured, and does not hide another store error as 404', async () => {
    const t = build();
    const id = await ready(t, t.rw);
    t.files.head = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    expect((await link(t, 'reader', id)).status).toBe(503);
    expect((await link(build({ files: false }), 'reader', NIL)).status).toBe(503);
  });
});

describe('POST /v1/attachments/urls', () => {
  const urls = (t: ReturnType<typeof build>, who: string | undefined, body: unknown) => t.send(who, 'POST', '/v1/attachments/urls', body);

  it('gives a link for each ready attachment the caller can read and leaves out the others, without telling which are missing', async () => {
    const t = build();
    const mine = await t.uploaded('writer', t.rw);
    await t.send('writer', 'POST', `/v1/attachments/${mine}/complete`);
    const other = await t.uploaded('writer', t.rw);
    await t.send('writer', 'POST', `/v1/attachments/${other}/complete`);
    t.attachments.seed({ id: '00000000-0000-4000-8000-0000000003aa', pageId: t.closed, uploaderId: t.uid('writer'), fileName: 'h.png', contentType: 'image/png', size: 1, key: 'attachments/h', status: 'ready', expiresAt: null, createdAt: 1, readyAt: 1 });
    const pendingId = await t.uploaded('writer', t.rw);
    const res = await urls(t, 'reader', { ids: [mine, mine, other, pendingId, NIL, '00000000-0000-4000-8000-0000000003aa'] });
    expect([res.status, res.headers.get('cache-control')]).toEqual([200, 'no-store']);
    const body = (await res.json()) as { urls: { id: string; url: string }[] };
    expect(body.urls.map((u) => u.id).sort()).toEqual([mine, other].sort());
    expect(await (await urls(t, 'reader', { ids: [NIL] })).json()).toEqual({ urls: [] });
  });

  it('asks for downloads when told to', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw);
    await t.send('writer', 'POST', `/v1/attachments/${id}/complete`);
    await urls(t, 'reader', { ids: [id], download: true });
    expect(t.files.signed.at(-1)).toMatchObject({ disposition: 'attachment' });
  });

  it('is 422 with no id or more than 50, 401 without a token, and 503 when the store is not configured or does not answer', async () => {
    const t = build();
    expect((await urls(t, 'reader', { ids: [] })).status).toBe(422);
    expect((await urls(t, 'reader', { ids: Array.from({ length: 51 }, () => NIL) })).status).toBe(422);
    expect((await urls(t, 'reader', { ids: Array.from({ length: 50 }, () => NIL) })).status).toBe(200);
    expect((await urls(t, undefined, { ids: [NIL] })).status).toBe(401);
    expect((await urls(build({ files: false }), 'reader', { ids: [NIL] })).status).toBe(503);
    const id = await t.uploaded('writer', t.rw);
    await t.send('writer', 'POST', `/v1/attachments/${id}/complete`);
    t.files.signDownload = () => Promise.reject(new FileStorageError('unavailable', 'down'));
    expect((await urls(t, 'reader', { ids: [id] })).status).toBe(503);
  });
});

describe('what the log may hold', () => {
  it('has the events with ids and numbers only, and no key, signed URL or store message', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw, PNG.slice(0, 10), { size: PNG.length });
    await t.send('writer', 'POST', `/v1/attachments/${id}/complete`);
    t.files.signUpload = () => Promise.reject(new FileStorageError('unavailable', 'secret-store-message'));
    await t.create('writer', t.rw);
    const text = JSON.stringify(t.logs.entries);
    expect(text).toContain('attachments.upload_created');
    expect(text).toContain('attachments.refused');
    expect(text).toContain('files.unavailable');
    for (const bad of ['X-Amz-', 'attachments/0', 'fake.invalid', 'secret-store-message']) expect(text, bad).not.toContain(bad);
  });
});

// docs/tenancy.md 3.5 (section 7, item 3): an attachment of another tenant is not found, whatever page it names, and no link is signed for it.
describe('attachments and tenants', () => {
  const OTHER = '00000000-0000-4000-8000-0000000003bb';
  const foreign = (t: ReturnType<typeof build>, over: object = {}) => t.attachments.seed({
    id: OTHER, pageId: t.rw, uploaderId: t.uid('writer'), fileName: 'b.png', contentType: 'image/png', size: 1, key: `tenants/tenant-b/attachments/${OTHER}`,
    tenantId: 'tenant-b', status: 'ready', expiresAt: null, createdAt: 0, readyAt: 0, ...over,
  });

  it('puts the key of a new upload under the caller\'s tenant', async () => {
    const t = build();
    const id = await t.uploaded('writer', t.rw);
    expect((await t.attachments.get(id))?.key).toBe(`tenants/legacy/attachments/${id}`);
  });

  it('is 404 for the link to a ready attachment of another tenant, even on a page the caller can read, and signs nothing', async () => {
    const t = build();
    foreign(t);
    const before = t.files.signed.length;
    expect((await t.send('reader', 'GET', `/v1/attachments/${OTHER}`)).status).toBe(404);
    expect(t.files.signed.length).toBe(before);
  });

  it('leaves an attachment of another tenant out of the batch of links, as one that does not exist', async () => {
    const t = build();
    const mine = await t.uploaded('writer', t.rw);
    await t.send('writer', 'POST', `/v1/attachments/${mine}/complete`);
    foreign(t);
    const res = await t.send('reader', 'POST', '/v1/attachments/urls', { ids: [mine, OTHER] });
    expect(((await res.json()) as { urls: { id: string }[] }).urls.map((u) => u.id)).toEqual([mine]);
  });

  it('is 404 to complete an upload of another tenant, and 409 to replay its create', async () => {
    const t = build();
    foreign(t, { status: 'pending', expiresAt: 9e12 });
    expect((await t.send('writer', 'POST', `/v1/attachments/${OTHER}/complete`)).status).toBe(404);
  });
});

