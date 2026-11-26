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
import type { UploadSizing } from '../../src/import/upload-plan.js';
import { buildZip } from '../import/hostile/zip-builder.js';
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
const ZIP = buildZip([{ name: 'a.md', data: Buffer.from('# a\n') }]);
const MIB = 1024 * 1024;
/** Parts of 5 MiB (the least a store takes) from 10 MiB up: a file of 12 MiB goes up as 5 + 5 + 2. */
const SIZING: UploadSizing = { singleMaxBytes: 10 * MIB, partBytes: 5 * MIB };
const BIG = 12 * MIB;
const BIG_FILE = { files: [{ fileName: 'big.zip', size: BIG }] };
/** Bytes that start as a zip does (the start checks the signature of the object). */
const zipBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(ZIP.subarray(0, 4));
  return bytes;
};

function build(options: { files?: boolean; enqueueFails?: boolean; cleanupFails?: boolean; sizing?: UploadSizing } = {}) {
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
  const config = { ...t.ctx.config, ...(options.files === false ? {} : { files: FILES }), ...(options.sizing === undefined ? {} : { import: { ...t.ctx.config.import, uploadSizing: options.sizing } }) };
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
      enqueueImport: (payload, opts) => {
        if (options.enqueueFails === true) return Promise.reject(new Error('jobs-unavailable'));
        enqueued.push({ name: 'import', payload, options: opts });
        return Promise.resolve('job-1');
      },
      enqueueImportCleanup: (payload) => {
        if (options.cleanupFails === true) return Promise.reject(new Error('jobs-unavailable'));
        enqueued.push({ name: 'import-cleanup', payload, options: undefined });
        return Promise.resolve('job-2');
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
    const res = await call(who, 'POST', '/v1/imports', { collectionId, files: [{ fileName: 'export.zip', size: ZIP.length }], ...over });
    return { res, id: ((await res.clone().json()) as { id?: string }).id ?? '' };
  };
  const sent = async (id: string, tenant = 'T-a', bytes: Uint8Array = ZIP) => {
    await files.put(importZipKey(tenant, id), bytes, { size: bytes.length, contentType: 'application/zip' });
  };
  const partUrls = (id: string, index: number, partNumbers: unknown, who = 'ada') => call(who, 'POST', `/v1/imports/${id}/parts/${String(index)}/urls`, { partNumbers });
  /** One part sent as the browser does it: the signed address from the route, then the bytes to that address. */
  const sendPart = async (id: string, index: number, partNumber: number, body: Uint8Array) => {
    const res = await partUrls(id, index, [partNumber]);
    expect(res.status).toBe(200);
    const { urls } = (await res.json()) as { urls: { url: string; headers: Record<string, string> }[] };
    await files.receiveSignedUpload(urls[0]!.url, urls[0]!.headers, body);
  };
  /** An import of ada's that is running: sent, and moved there by the repository as the job does. */
  const running = async () => {
    const { id } = await made();
    await sent(id);
    await imports.markUploaded('T-a', id);
    expect(await imports.start('T-a', id, t.clock.now())).toMatchObject({ status: 'running' });
    return id;
  };
  return { call, made, sent, running, partUrls, sendPart, uid, imports, files, enqueued, collections, world, rw, ro, theirs, audit: collections.audit, clock: t.clock, logs: t.logger };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('POST /v1/imports', () => {
  it('makes an import and a signed PUT for the zip under the tenant, for at least 3,000 seconds, never cached', async () => {
    const t = build();
    const { res, id } = await t.made();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { id: string; uploads: { index: number; upload: { kind: string; method: string; headers: Record<string, string>; expiresAt: string } }[] };
    expect(body.uploads.map((u) => u.index)).toEqual([0]);
    const upload = body.uploads[0]!.upload;
    expect(upload).toMatchObject({ kind: 'single', method: 'PUT', headers: { 'content-type': 'application/zip', 'if-none-match': '*' } });
    expect(upload.expiresAt).toBe(new Date(upload.expiresAt).toISOString()); // an ISO string, as every time in the API
    expect(Date.parse(upload.expiresAt) - t.clock.now()).toBeGreaterThanOrEqual(3_000_000);
    expect(await t.imports.get('T-a', id)).toMatchObject({ status: 'created', createdBy: t.uid('ada'), targetCollectionId: t.rw.id, bytes: ZIP.length, s3Key: importZipKey('T-a', id), source: 'markdown_zip' });
    expect(await t.imports.parts('T-a', id)).toEqual([{ ordinal: 0, s3Key: importZipKey('T-a', id), bytes: ZIP.length, uploadId: null }]);
  });

  it('refuses a zip above the largest an import takes (413), and a request that is not valid or has more in it than the contract has (422)', async () => {
    const t = build();
    const one = (over: object) => ({ files: [{ fileName: 'export.zip', size: ZIP.length, ...over }] });
    expect(await code((await t.made(one({ size: 10 ** 12 }))).res)).toBe('too_large');
    for (const over of [one({ size: 0 }), one({ size: 1.5 }), one({ size: '10' }), one({ fileName: '' }), one({ extra: 1 }), { collectionId: 'nope' }, { databaseMode: 'table' }]) {
      const { res } = await t.made(over);
      expect([res.status, await code(res)], JSON.stringify(over)).toEqual([422, 'invalid']);
    }
    expect(await code(await t.call('ada', 'POST', '/v1/imports', { collectionId: t.rw.id }))).toBe('invalid');
  });

  it('takes one file for now (no files, or two, is 422): the job reads the first zip only until it reads them all, so a second file would be sent and silently left out', async () => {
    const t = build();
    for (const over of [{ files: [] }, { files: [{ fileName: 'a.zip', size: 1 }, { fileName: 'b.zip', size: 1 }] }]) {
      const { res } = await t.made(over);
      expect([res.status, await code(res)], JSON.stringify(over)).toEqual([422, 'invalid']);
    }
    expect(t.imports.count()).toBe(0);
  });

  it('reads the archive with the profile the person names: notion_md_csv for an export of Notion, markdown_zip when none is named; any other is 422', async () => {
    const t = build();
    const notion = await t.made({ profile: 'notion_md_csv' });
    expect(notion.res.status).toBe(201);
    expect(await t.imports.get('T-a', notion.id)).toMatchObject({ source: 'notion_md_csv' });
    const plain = await t.made({ profile: 'markdown_zip' });
    expect(await t.imports.get('T-a', plain.id)).toMatchObject({ source: 'markdown_zip' });
    const other = await t.made({ profile: 'word_document' });
    expect([other.res.status, await code(other.res)]).toEqual([422, 'invalid']);
  });

  it('needs a collection the caller can write: one they can only read is 403, one of another workspace or unknown is 404, and nobody signed in is 401', async () => {
    const t = build();
    expect([(await t.made({}, 'ada', t.ro.id)).res.status]).toEqual([403]);
    expect((await t.made({}, 'ada', t.theirs.id)).res.status).toBe(404);
    expect((await t.made({}, 'ada', '00000000-0000-4000-8000-0000000000ff')).res.status).toBe(404);
    expect((await t.call(undefined, 'POST', '/v1/imports', { collectionId: t.rw.id, files: [{ fileName: 'a.zip', size: 10 }] })).status).toBe(401);
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
  it('accepts a zip that arrived: 202, waiting (the job runs it), one job for this import of this tenant, one audit row', async () => {
    const t = build();
    const { id } = await t.made();
    await t.sent(id);
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([res.status, await res.json()]).toEqual([202, { status: 'uploaded' }]);
    expect(await t.imports.get('T-a', id)).toMatchObject({ status: 'uploaded' });
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: id, tenantId: 'T-a' }, options: { singletonKey: `import:${id}` } }]);
    expect(t.audit.events).toMatchObject([{ action: 'import.started', targetType: 'import', targetId: id, tenantId: 'T-a', actorId: t.uid('ada') }]);
    // Asking again while it waits is safe (the queue keeps one job for the import); once it runs the start is refused.
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    expect(t.audit.events, 'one import is audited as started once, however often it is asked').toHaveLength(1);
    await t.imports.start('T-a', id, t.clock.now());
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('already_started');
  });

  it('says what is wrong with the file: not sent (409 upload_missing), another size (409 size_mismatch), not a zip (422 not_a_zip); the import stays as it was', async () => {
    const t = build();
    const a = (await t.made()).id;
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${a}/start`))).toBe('upload_missing');
    const b = (await t.made()).id;
    await t.sent(b, 'T-a', new Uint8Array(ZIP.length + 1).fill(7));
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${b}/start`))).toBe('size_mismatch');
    const c = (await t.made()).id;
    await t.sent(c, 'T-a', new Uint8Array(ZIP.length).fill(0x41));
    const bad = await t.call('ada', 'POST', `/v1/imports/${c}/start`);
    expect([bad.status, await code(bad)]).toEqual([422, 'not_a_zip']);
    for (const id of [a, b, c]) expect((await t.imports.get('T-a', id))?.status).toBe('created');
    expect(t.enqueued).toEqual([]);
  });

  it('checks the signature the archive reader requires (the same two), not just PK: a file that starts with PK and is not a zip start is 422 not_a_zip, an empty archive and a zip are taken; and a store that fails on the read is 503, never not_a_zip', async () => {
    const t = build();
    const notAStart = Buffer.from(ZIP);
    notAStart[2] = 0x01; // `PK\x01\x02`: the signature of a central directory entry, not of an archive's start
    const { id } = await t.made({ files: [{ fileName: 'export.zip', size: notAStart.length }] });
    await t.sent(id, 'T-a', notAStart);
    const refused = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([refused.status, await code(refused)]).toEqual([422, 'not_a_zip']);
    expect((await t.imports.get('T-a', id))?.status).toBe('created');
    const empty = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]); // an archive with no entry
    const e = await t.made({ files: [{ fileName: 'export.zip', size: empty.length }] });
    await t.sent(e.id, 'T-a', empty);
    expect((await t.call('ada', 'POST', `/v1/imports/${e.id}/start`)).status).toBe(202);
    const f = await t.made();
    await t.sent(f.id);
    vi.spyOn(t.files, 'get').mockImplementationOnce(() => Promise.reject(new FileStorageError('unavailable', 'down')));
    expect((await t.call('ada', 'POST', `/v1/imports/${f.id}/start`)).status).toBe(503);
    expect((await t.imports.get('T-a', f.id))?.status).toBe('created');
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

  it('accepts every start, whatever else runs: a workspace with a running import gets the next one queued and waiting, never refused', async () => {
    const t = build();
    await t.running();
    const second = (await t.made()).id;
    await t.sent(second);
    const res = await t.call('ada', 'POST', `/v1/imports/${second}/start`);
    expect([res.status, await res.json()]).toEqual([202, { status: 'uploaded' }]);
    expect((await t.imports.get('T-a', second))?.status).toBe('uploaded');
    expect(t.enqueued).toEqual([{ name: 'import', payload: { importId: second, tenantId: 'T-a' }, options: { singletonKey: `import:${second}` } }]);
  });

  it('two starts at once are both accepted and queued: both wait, and the database lets one run at a time', async () => {
    const t = build();
    const a = (await t.made()).id;
    const b = (await t.made()).id;
    await t.sent(a);
    await t.sent(b);
    const results = await Promise.all([t.call('ada', 'POST', `/v1/imports/${a}/start`), t.call('ada', 'POST', `/v1/imports/${b}/start`)]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(t.enqueued).toHaveLength(2);
    // What the two jobs then do, at once: one moves its import to running, the other is turned away and its import waits (and another workspace's would run beside it).
    const turns = await Promise.allSettled([t.imports.start('T-a', a, t.clock.now()), t.imports.start('T-a', b, t.clock.now())]);
    expect(turns.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect([(await t.imports.get('T-a', a))?.status, (await t.imports.get('T-a', b))?.status].sort()).toEqual(['running', 'uploaded']);
  });

  it('answers 503 when the job cannot be queued, and the import waits as `uploaded`, so that the start can be tried again', async () => {
    const t = build({ enqueueFails: true });
    const { id } = await t.made();
    await t.sent(id);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(503);
    expect((await t.imports.get('T-a', id))?.status).toBe('uploaded');
    expect(t.audit.events, 'the import was accepted, once').toHaveLength(1);
    // A queue failure has an operation of its own: it does not read as the file store's (`import-start` is where the store was being looked at).
    expect(t.logs.entries.filter((e) => e.event === 'files.unavailable').map((e) => e.fields?.['operation'])).toEqual(['import-enqueue']);
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

  it('is 409 already_started when another start got there first (the row moved after this one looked)', async () => {
    const t = build();
    const id = await sendAndStart(t);
    vi.spyOn(t.imports, 'markUploaded').mockResolvedValueOnce(false);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('already_started');
    expect(t.enqueued).toEqual([]);
  });
});

describe('cancelling an import that waits for its turn', () => {
  it('withdraws an accepted import that waits as uploaded, for its creator or an administrator of the workspace: 200, cancelled, audited, and no start follows', async () => {
    const t = build();
    await t.running();
    const { id } = await t.made();
    await t.sent(id);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    const res = await t.call('root', 'POST', `/v1/imports/${id}/cancel`);
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([200, 'cancelled']);
    expect(t.audit.events.map((e) => e.action)).toEqual(['import.started', 'import.cancelled']);
    expect(await t.imports.start('T-a', id, t.clock.now())).toBeUndefined();
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/cancel`))).toBe('not_running');
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
        report: { constructs: [], rawHtmlPages: [], rawHtmlCapped: false },
      });
    }
    for (const who of ['bob', 'eve']) expect((await t.call(who, 'GET', `/v1/imports/${id}`)).status, who).toBe(404);
    expect((await t.call('ada', 'GET', '/v1/imports/00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });
  it('says there was nothing to report when the import is gone between the look and the report', async () => {
    const t = build();
    const id = await t.running();
    vi.spyOn(t.imports, 'constructReport').mockResolvedValueOnce(undefined);
    const res = await t.call('ada', 'GET', `/v1/imports/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { report: unknown }).report).toEqual({ constructs: [], rawHtmlPages: [], rawHtmlCapped: false });
  });
  it('carries the construct report: what the written pages held, the pages that hold it with their address, the databases and rows, and the pages that still hold HTML; a path is cut and cleaned', async () => {
    const t = build();
    const id = await t.running();
    await t.imports.addItems('T-a', id, [
      { path: `a\u0007${'x'.repeat(400)}.md`, kind: 'page' },
      { path: 'db.csv', kind: 'database_csv' },
      { path: 'row.md', kind: 'page', status: 'skipped', message: 'database_row' },
    ]);
    const [a] = await t.imports.pending('T-a', id, 'page', 10);
    const [db] = await t.imports.pending('T-a', id, 'database_csv', 10);
    const page = (itemId: string, constructs?: Record<string, number>) => ({ itemId, collectionId: 'c', parentId: null, position: (before: string | null) => `${before ?? ''}a`, title: 'T', createdBy: 'u', content: { state: new Uint8Array([1]), markdown: 'x', text: 'x', hash: Buffer.alloc(32) }, markdownBytes: 1, stateBytes: 1, attachments: [], ...(constructs === undefined ? {} : { constructs }) });
    await t.imports.writePage('T-a', id, page(a!.id, { callout: 2, raw_html: 3 }));
    await t.imports.writePage('T-a', id, page(db!.id));
    const items = await t.imports.scanItems('T-a', id, { limit: 10 });
    const urlOf = (itemId: string) => items.find((i) => i.id === itemId)?.urlId;
    const cut = `a${'x'.repeat(299)}`;
    for (const who of ['ada', 'root']) {
      const body = (await (await t.call(who, 'GET', `/v1/imports/${id}`)).json()) as { report: unknown };
      expect(body.report, who).toEqual({
        constructs: [
          { kind: 'callout', fate: 'converted', count: 2, pages: [{ itemId: a!.id, path: cut, urlId: urlOf(a!.id) }], capped: false },
          { kind: 'raw_html', fate: 'kept', count: 3, pages: [{ itemId: a!.id, path: cut, urlId: urlOf(a!.id) }], capped: false },
          { kind: 'database_table', fate: 'converted', count: 1, pages: [{ itemId: db!.id, path: 'db.csv', urlId: urlOf(db!.id) }], capped: false },
          { kind: 'database_row', fate: 'dropped', count: 1, pages: [{ itemId: items.find((i) => i.path === 'row.md')!.id, path: 'row.md', urlId: null }], capped: false },
        ],
        rawHtmlPages: [{ itemId: a!.id, path: cut, urlId: urlOf(a!.id), fragments: 3 }],
        rawHtmlCapped: false,
      });
    }
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
    expect(Object.keys(body.items[0]!).sort()).toEqual(['hasSource', 'id', 'kind', 'markdownBytes', 'message', 'pageId', 'path', 'remoteImageFailures', 'stateBytes', 'status']);
  });

  it('says, for each file, how many remote pictures were not copied and why, as a count for each reason code and never an address; a file with none says {}', async () => {
    const t = build();
    const id = await t.running();
    await t.imports.addItems('T-a', id, [{ path: 'a.md', kind: 'page' }, { path: 'b.md', kind: 'page' }]);
    const [a, b] = await t.imports.pending('T-a', id, 'page', 10);
    // What an engine stores: codes and counts. A key that is not a code (it could carry an address) and a count that is not a whole number are not passed on.
    await t.imports.settle('T-a', id, a!.id, { status: 'failed', message: 'content-lost', remoteImageFailures: { blocked_address: 2, timeout: 1, 'http://10.0.0.1/x.png': 3, too_large: -1, status: 1.5 } });
    await t.imports.settle('T-a', id, b!.id, { status: 'skipped', message: 'too_large' });
    const body = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items`)).json()) as { items: { path: string; remoteImageFailures: Record<string, number> }[] };
    expect(body.items.map((i) => [i.path, i.remoteImageFailures])).toEqual([
      ['a.md', { blocked_address: 2, timeout: 1 }],
      ['b.md', {}],
    ]);
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
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.expiresAt).toBe(new Date(body.expiresAt).toISOString());
    expect(Date.parse(body.expiresAt) - t.clock.now()).toBeLessThanOrEqual(300_000);
    expect(sign).toHaveBeenCalledWith(
      importFailedKey('T-a', id, broken.id),
      expect.objectContaining({ disposition: 'attachment', contentType: 'application/octet-stream', fileName: expect.stringContaining('broken') as string }),
    );
    expect(body.url).toEqual(expect.any(String));
    expect((await t.call('root', 'GET', `/v1/imports/${id}/items/${broken.id}/source`)).status).toBe(200);
  });

  it('gives the kept original of a failed database (its CSV) the same way, and says so in the report; a failed file of another kind has none', async () => {
    const t = build();
    const id = await t.running();
    await t.imports.addItems('T-a', id, [
      { path: 'db/Tasks.csv', kind: 'database_csv' },
      { path: 'img/c.png', kind: 'attachment' },
    ]);
    const [table] = await t.imports.pending('T-a', id, 'database_csv', 1);
    const [picture] = await t.imports.pending('T-a', id, 'attachment', 1);
    await t.imports.settle('T-a', id, table!.id, { status: 'failed', message: 'table_too_large' });
    await t.imports.settle('T-a', id, picture!.id, { status: 'failed', message: 'type_not_allowed' });
    for (const item of [table!, picture!]) await t.files.put(importFailedKey('T-a', id, item.id), new Uint8Array([97]), { size: 1, contentType: 'text/csv' });
    const listed = (await (await t.call('ada', 'GET', `/v1/imports/${id}/items`)).json()) as { items: { path: string; hasSource: boolean }[] };
    expect(listed.items.map((i) => [i.path, i.hasSource])).toEqual([
      ['db/Tasks.csv', true],
      ['img/c.png', false],
    ]);
    const sign = vi.spyOn(t.files, 'signDownload');
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/${table!.id}/source`)).status).toBe(200);
    expect(sign).toHaveBeenCalledWith(importFailedKey('T-a', id, table!.id), expect.objectContaining({ disposition: 'attachment', contentType: 'application/octet-stream', fileName: 'Tasks.csv' }));
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/items/${picture!.id}/source`)).status, 'a failed attachment has no original to give').toBe(404);
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
    expect(await res.json()).toMatchObject({ status: 'cancelled', finishedAt: new Date(t.clock.now()).toISOString(), report: { constructs: [], rawHtmlPages: [], rawHtmlCapped: false } });
    expect(t.audit.events.map((e) => e.action)).toEqual(['import.cancelled']);
    expect(t.audit.events[0]).toMatchObject({ actorId: t.uid('root'), targetId: id, tenantId: 'T-a' });
  });

  it('hands the cleanup of the import to the queue (its pages go to the trash, its zip is deleted), by ids only', async () => {
    const t = build();
    const id = await t.running();
    expect((await t.call('root', 'POST', `/v1/imports/${id}/cancel`)).status).toBe(200);
    expect(t.enqueued).toEqual([{ name: 'import-cleanup', payload: { importId: id, tenantId: 'T-a' }, options: undefined }]);
    expect((await t.call('root', 'POST', `/v1/imports/${id}/cancel`)).status).toBe(409);
    expect(t.enqueued).toHaveLength(1); // a cancel that changed nothing hands nothing over
  });

  it('is still cancelled when the queue is not up: 200, and the failure is logged', async () => {
    const t = build({ cleanupFails: true });
    const id = await t.running();
    const res = await t.call('root', 'POST', `/v1/imports/${id}/cancel`);
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([200, 'cancelled']);
    expect(t.enqueued).toEqual([]);
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

describe('POST /v1/imports for a file that goes up in parts', () => {
  it('opens a multipart upload from the single-PUT size up, and tells the page the part size and count, never the upload id', async () => {
    const t = build({ sizing: SIZING });
    const { res, id } = await t.made(BIG_FILE);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ id, uploads: [{ index: 0, upload: { kind: 'multipart', partSize: 5 * MIB, partCount: 3 } }] });
    const [part] = await t.imports.parts('T-a', id);
    expect(part).toMatchObject({ ordinal: 0, s3Key: importZipKey('T-a', id), bytes: BIG });
    const uploadId = part?.uploadId;
    if (uploadId === null || uploadId === undefined) throw new Error('the part has no upload id');
    expect(text).not.toContain(uploadId);
    expect(await t.files.listParts(importZipKey('T-a', id), uploadId)).toEqual([]); // open, and empty
    expect(await t.imports.get('T-a', id)).toMatchObject({ bytes: BIG });
  });

  it('keeps one signed PUT for a file just under that size', async () => {
    const t = build({ sizing: SIZING });
    const { res } = await t.made({ files: [{ fileName: 'a.zip', size: 10 * MIB - 1 }] });
    expect(((await res.json()) as { uploads: { upload: { kind: string } }[] }).uploads[0]?.upload.kind).toBe('single');
  });

  it('ends the upload it opened when the import cannot be made, so that no session is left in the store', async () => {
    const t = build({ sizing: SIZING });
    const opened: [string, string][] = [];
    const real = t.files.createMultipart.bind(t.files);
    vi.spyOn(t.files, 'createMultipart').mockImplementation(async (key, o) => {
      const made = await real(key, o);
      opened.push([key, made.uploadId]);
      return made;
    });
    vi.spyOn(t.imports, 'create').mockRejectedValue(new Error('database down'));
    expect((await t.made(BIG_FILE)).res.status).toBe(503); // an error nobody expected is the service being unavailable, as everywhere in the API
    expect(t.imports.count()).toBe(0);
    expect(opened).toHaveLength(1);
    await expect(t.files.listParts(opened[0]![0], opened[0]![1])).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('POST /v1/imports/{id}/parts/{index}/urls', () => {
  it('signs each part for its exact length, for 15 minutes at most', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    const res = await t.partUrls(id, 0, [1, 3]);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { urls } = (await res.json()) as { urls: { partNumber: number; method: string; url: string; headers: Record<string, string>; expiresAt: string }[] };
    expect(urls.map((u) => [u.partNumber, u.method])).toEqual([[1, 'PUT'], [3, 'PUT']]);
    for (const u of urls) {
      expect(u.expiresAt).toBe(new Date(u.expiresAt).toISOString());
      expect(Date.parse(u.expiresAt) - t.clock.now()).toBe(15 * 60 * 1000);
    }
    // the last part is what is left of the file; a body of another length is refused by the store
    await t.files.receiveSignedUpload(urls[1]!.url, urls[1]!.headers, new Uint8Array(2 * MIB));
    await expect(t.files.receiveSignedUpload(urls[0]!.url, urls[0]!.headers, new Uint8Array(2 * MIB))).rejects.toThrow();
    await t.files.receiveSignedUpload(urls[0]!.url, urls[0]!.headers, new Uint8Array(5 * MIB));
  });

  it('gives at most 50 addresses at a time, and only for the parts of the file (1 to the count), each once: 422', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made({ files: [{ fileName: 'big.zip', size: 51 * 5 * MIB }] }); // 51 parts
    const all = Array.from({ length: 51 }, (_, n) => n + 1);
    expect((await t.partUrls(id, 0, all.slice(0, 50))).status).toBe(200);
    for (const bad of [all, [], [0], [52], [1, 1], [1.5], ['1'], 'all']) {
      const res = await t.partUrls(id, 0, bad);
      expect([res.status, await code(res)], JSON.stringify(bad)).toEqual([422, 'invalid']);
    }
  });

  it('is for the creator only, and for a file that goes up in parts: 404 for anyone else, for a file that is not there, and for one sent as a single PUT', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    for (const who of ['bob', 'root', 'eve']) expect((await t.partUrls(id, 0, [1], who)).status, who).toBe(404);
    expect((await t.partUrls(id, 1, [1])).status).toBe(404);
    const small = await t.made();
    expect((await t.partUrls(small.id, 0, [1])).status).toBe(404);
  });

  it('is 409 already_started once the import was started, and 401 without a sign-in', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    await t.sendPart(id, 0, 3, new Uint8Array(2 * MIB));
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    expect(await code(await t.partUrls(id, 0, [1]))).toBe('already_started');
    expect((await t.call(undefined, 'POST', `/v1/imports/${id}/parts/0/urls`, { partNumbers: [1] })).status).toBe(401);
  });
});

describe('GET /v1/imports/{id}/parts/{index}', () => {
  it('lists the parts the store holds, with the size and count of the parts, so that a page that was reloaded sends only the rest', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    const list = async () => (await t.call('ada', 'GET', `/v1/imports/${id}/parts/0`)).json();
    expect(await list()).toEqual({ partSize: 5 * MIB, partCount: 3, parts: [] });
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    expect(await list()).toEqual({ partSize: 5 * MIB, partCount: 3, parts: [{ partNumber: 2, size: 5 * MIB }] });
  });

  it('is for the creator only, for a file that goes up in parts, while the import is not started: 404, 404, 409', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    for (const who of ['bob', 'root', 'eve']) expect((await t.call(who, 'GET', `/v1/imports/${id}/parts/0`)).status, who).toBe(404);
    expect((await t.call('ada', 'GET', `/v1/imports/${id}/parts/1`)).status).toBe(404);
    const small = await t.made();
    expect((await t.call('ada', 'GET', `/v1/imports/${small.id}/parts/0`)).status).toBe(404);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    await t.sendPart(id, 0, 3, new Uint8Array(2 * MIB));
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    expect(await code(await t.call('ada', 'GET', `/v1/imports/${id}/parts/0`))).toBe('already_started');
  });

  it('is 409 upload_missing when the store no longer has the upload (it dropped it), and nothing is listed', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    const [part] = await t.imports.parts('T-a', id);
    await t.files.abortMultipart(part!.s3Key, part!.uploadId!);
    expect(await code(await t.call('ada', 'GET', `/v1/imports/${id}/parts/0`))).toBe('upload_missing');
  });
});

describe('POST /v1/imports/{id}/start for a file that went up in parts', () => {
  it('joins the parts the store holds, then checks the object as it does any zip, and again when asked again', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    await t.sendPart(id, 0, 3, new Uint8Array(2 * MIB));
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([202, 'uploaded']);
    expect(await t.imports.parts('T-a', id)).toEqual([{ ordinal: 0, s3Key: importZipKey('T-a', id), bytes: BIG, uploadId: null }]);
    expect((await t.files.head(importZipKey('T-a', id))).size).toBe(BIG);
    expect(t.enqueued.map((e) => e.name)).toEqual(['import']);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202); // the parts are joined: nothing to ask the store for
  });

  it('is 409 part_missing while a part is not there, leaves the import as it was, and works once the part is sent', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    await t.sendPart(id, 0, 3, new Uint8Array(2 * MIB));
    const early = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([early.status, await code(early)]).toEqual([409, 'part_missing']);
    expect(await t.imports.get('T-a', id)).toMatchObject({ status: 'created' });
    expect((await t.imports.parts('T-a', id))[0]?.uploadId).toEqual(expect.any(String));
    expect(t.enqueued).toEqual([]);
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
  });

  it('is 422 not_a_zip when the joined object does not start as a zip, and queues nothing', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    for (const [n, size] of [[1, 5 * MIB], [2, 5 * MIB], [3, 2 * MIB]] as const) await t.sendPart(id, 0, n, new Uint8Array(size));
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/start`);
    expect([res.status, await code(res)]).toEqual([422, 'not_a_zip']);
    expect(t.enqueued).toEqual([]);
  });

  it('works when asked again after a start that joined the parts and died before writing it down (the upload is gone, the object is there)', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    await t.sendPart(id, 0, 2, new Uint8Array(5 * MIB));
    await t.sendPart(id, 0, 3, new Uint8Array(2 * MIB));
    vi.spyOn(t.imports, 'closePart').mockRejectedValueOnce(new Error('database down'));
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(503);
    expect((await t.imports.parts('T-a', id))[0]?.uploadId).toEqual(expect.any(String)); // not written down
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    expect((await t.imports.parts('T-a', id))[0]?.uploadId).toBeNull();
    expect(t.enqueued.map((e) => e.name)).toEqual(['import']);
  });

  it('is 409 upload_missing when the upload is gone and no object is there either (the store dropped it)', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    const [part] = await t.imports.parts('T-a', id);
    await t.files.abortMultipart(part!.s3Key, part!.uploadId!);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/start`))).toBe('upload_missing');
  });

  it('starts a row that has no part from the key and the size it has, and is 409 upload_missing for one that has no size', async () => {
    const t = build();
    const keyed = '00000000-0000-4000-8000-0000000000c3';
    t.imports.seed({ id: keyed, tenantId: 'T-a', status: 'uploaded', createdBy: t.uid('ada'), targetCollectionId: t.rw.id, bytes: ZIP.length, s3Key: importZipKey('T-a', keyed) });
    await t.sent(keyed);
    expect((await t.call('ada', 'POST', `/v1/imports/${keyed}/start`)).status).toBe(202);
    const sizeless = '00000000-0000-4000-8000-0000000000c4';
    t.imports.seed({ id: sizeless, tenantId: 'T-a', status: 'uploaded', createdBy: t.uid('ada'), targetCollectionId: t.rw.id });
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${sizeless}/start`))).toBe('upload_missing');
  });
});

describe('POST /v1/imports/{id}/abort', () => {
  it('ends an upload that was not started: the import is abandoned and its cleanup, which ends the multipart upload and deletes the parts, is handed to the queue by ids only', async () => {
    const t = build({ sizing: SIZING });
    const { id } = await t.made(BIG_FILE);
    await t.sendPart(id, 0, 1, zipBytes(5 * MIB));
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/abort`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'failed', error: 'abandoned', finishedAt: new Date(t.clock.now()).toISOString(), report: { constructs: [], rawHtmlPages: [], rawHtmlCapped: false } }); // the same state every import answer has
    expect(t.enqueued).toEqual([{ name: 'import-cleanup', payload: { importId: id, tenantId: 'T-a' }, options: undefined }]);
  });

  it('is still done when the queue is not up: 200, and the failure is logged (the daily cleanup makes up for it)', async () => {
    const t = build({ sizing: SIZING, cleanupFails: true });
    const { id } = await t.made(BIG_FILE);
    const res = await t.call('ada', 'POST', `/v1/imports/${id}/abort`);
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([200, 'failed']);
  });

  it('does not fail an import that a start accepted between the look and the abort: 409 already_started, nothing handed to the queue', async () => {
    const t = build();
    const { id } = await t.made();
    await t.sent(id);
    // The route has read `created`; by the time it writes, a start has made the import `uploaded`: the write takes only `created`, so it changes nothing.
    vi.spyOn(t.imports, 'abort').mockImplementationOnce(async (tenant, importId, now) => {
      expect(await t.imports.markUploaded(tenant, importId)).toBe(true);
      return t.imports.abort(tenant, importId, now);
    });
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/abort`))).toBe('already_started');
    expect((await t.imports.get('T-a', id))?.status).toBe('uploaded');
    expect(t.enqueued).toEqual([]);
  });

  it('is for the creator only, and for an upload that was not started: 404, then 409 already_started, and a second abort changes nothing', async () => {
    const t = build();
    const { id } = await t.made();
    for (const who of ['bob', 'root', 'eve']) expect((await t.call(who, 'POST', `/v1/imports/${id}/abort`)).status, who).toBe(404);
    await t.sent(id);
    expect((await t.call('ada', 'POST', `/v1/imports/${id}/start`)).status).toBe(202);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${id}/abort`))).toBe('already_started');
    const other = await t.made();
    expect((await t.call('ada', 'POST', `/v1/imports/${other.id}/abort`)).status).toBe(200);
    expect(await code(await t.call('ada', 'POST', `/v1/imports/${other.id}/abort`))).toBe('already_started');
    expect(t.enqueued.filter((e) => e.name === 'import-cleanup')).toHaveLength(1);
  });
});
