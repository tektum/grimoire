import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFileStorage, ensureBucket } from '@tektum/grimoire-adapter-files-s3';
import { createAccessStore, createAttachments, createAudit, createCollections, createDatabase, createIdempotency, createPages, createTrash, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { insertCollection, insertPage, insertUser } from '@tektum/grimoire-test-support/database';
import { createApp } from '../../src/app.js';
import { deleteObjects } from '../../src/attachments/deps.js';
import { appUrl, createTestDatabase, dropTestDatabase, repoRoot, requireBuild, sqlAdmin } from '../server/support/harness.js';
import { makeContext } from '../server/support/context.js';

// The real database under the attachment routes, with the in-memory store: what the idempotency table keeps of a create, and that a purge removes the objects.
const DB = 'grimoire_m5t04_attachments';
const FILES = {
  endpoint: 'http://s3.invalid', publicEndpoint: 'http://s3.invalid', publicOrigin: 'http://s3.invalid', bucket: 'b', accessKey: 'a', secretKey: 's', region: 'r',
  addressing: 'path' as const, createOnlyHeader: 'if-none-match' as const, corsMode: 'external' as const, maxBytes: 1000, allowedTypes: ['image/png'], pendingMaxPerUser: 5,
};
// The Compose store of `make db-up`, with the identities `make db-up` writes to .env (read from the environment, else from that file; nothing is written here).
const dotEnv = ((): Record<string, string> => {
  try {
    return Object.fromEntries(readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n').flatMap((line) => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line); return m?.[1] !== undefined && m[2] !== undefined ? [[m[1], m[2]]] : []; }));
  } catch {
    return {};
  }
})();
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? dotEnv[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set: run \`make db-up\` to write .env`);
  return value;
}
const storeEndpoint = env('GRIMOIRE_S3_ENDPOINT', 'http://127.0.0.1:8333');
const storeBucket = env('GRIMOIRE_S3_BUCKET', 'grimoire');
const filesConfig = (over: Partial<FilesConfig> = {}): FilesConfig => ({
  endpoint: storeEndpoint, publicEndpoint: storeEndpoint.replace('127.0.0.1', 'localhost'), publicOrigin: new URL(storeEndpoint.replace('127.0.0.1', 'localhost')).origin, bucket: storeBucket,
  accessKey: env('GRIMOIRE_S3_ACCESS_KEY'), secretKey: env('GRIMOIRE_S3_SECRET_KEY'), region: 'us-east-1', addressing: 'path',
  createOnlyHeader: 'if-none-match', corsMode: 'api', maxBytes: 26_214_400, allowedTypes: ['image/png'], pendingMaxPerUser: 20, ...over,
});
const adminOptions = () => ({
  endpoint: storeEndpoint, bucket: storeBucket, region: 'us-east-1', addressing: 'path' as const, accessKey: env('GRIMOIRE_DEV_S3_ACCESS_KEY'),
  secretKey: env('GRIMOIRE_DEV_S3_SECRET_KEY'), allowedOrigins: env('GRIMOIRE_ALLOWED_ORIGINS', 'http://127.0.0.1:8080,http://localhost:8080').split(','),
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const run = (sql: string) => sqlAdmin(DB, sql);

let db: KyselyDatabase;
let files: FakeFileStorage;
let call: ReturnType<typeof caller>;
let pageId: string;

function appOver(store: FileStorage, settings: FilesConfig = FILES) {
  const t = makeContext();
  const config = makeFakeConfig({ files: settings, allowedEmailDomains: ['example.com'] });
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const users = createUserStore(db);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const access = createAccessStore(db);
  return createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, access: createPageAccess(access), authorizer: createAuthorizer(access), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      idempotency: createIdempotency(db), collections: createCollections(db), audit: createAudit(db), pages: createPages(db), trash: createTrash(db),
      attachments: createAttachments(db), files: store, deleteFiles: deleteObjects(store),
    },
  });
}

const caller = (app: ReturnType<typeof appOver>) => (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
  method, headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  db = createDatabase(appUrl(DB));
  await insertUser(run, { descope_user_id: 'd-member', email: 'member@example.com', role: 'member' });
  await insertUser(run, { descope_user_id: 'd-admin', email: 'admin@example.com', role: 'admin' });
  const collection = await insertCollection(run, { default_permission: 'read_write' });
  pageId = await insertPage(run, { collection_id: collection });
  files = new FakeFileStorage();
  call = caller(appOver(files));
}, 120_000);

afterAll(async () => {
  await db.close();
  await dropTestDatabase(DB);
});

const meta = () => ({ pageId, fileName: 'a.png', contentType: 'image/png', size: PNG.length });

describe('POST /v1/attachments on the real database', () => {
  it('keeps no signed URL in the idempotency table, and a replay signs a new one', async () => {
    const first = await call('member', 'POST', '/v1/attachments', meta(), { 'idempotency-key': 'int-1' });
    expect(first.status).toBe(201);
    const made = (await first.json()) as { id: string; upload: { url: string }; markdownPath: string };
    const stored = (await run(`select response::text as r from idempotency_keys`)) as { r: string }[];
    const kept = stored.map((row) => row.r).join('\n');
    expect(kept).toContain(made.id);
    for (const bad of ['X-Amz-', 'upload', made.upload.url, 'fake.invalid']) expect(kept, bad).not.toContain(bad);
    const replay = await call('member', 'POST', '/v1/attachments', meta(), { 'idempotency-key': 'int-1' });
    expect([replay.status, replay.headers.get('idempotent-replay')]).toEqual([201, 'true']);
    const again = (await replay.json()) as { id: string; upload: { url: string; expiresAt: number } };
    expect(again.id).toBe(made.id);
    expect(again.upload.url).not.toBe(made.upload.url);
    expect(Number(((await run(`select count(*) as n from attachments where id = '${made.id}'`)) as { n: string }[])[0]?.n)).toBe(1);
  });

  it('removes the stored objects when the page is deleted and purged, before the rows', async () => {
    const created = (await (await call('member', 'POST', '/v1/attachments', meta())).json()) as { id: string };
    await files.put(`attachments/${created.id}`, PNG, { size: PNG.length, contentType: 'image/png' });
    expect((await call('member', 'POST', `/v1/attachments/${created.id}/complete`)).status).toBe(200);
    await expect(files.head(`attachments/${created.id}`)).resolves.toMatchObject({ size: PNG.length });
    expect((await call('member', 'DELETE', `/v1/pages/${pageId}`)).status).toBeLessThan(300);
    expect((await call('admin', 'DELETE', `/v1/trash/${pageId}`)).status).toBeLessThan(300);
    await expect(files.head(`attachments/${created.id}`)).rejects.toMatchObject({ kind: 'not-found' });
    expect(Number(((await run(`select count(*) as n from attachments where page_id = '${pageId}'`)) as { n: string }[])[0]?.n)).toBe(0);
  });
});

describe('a purge on the real store', () => {
  it('removes the stored object of a completed attachment, and leaves no row', async () => {
    await ensureBucket(adminOptions());
    const real = createFileStorage(filesConfig({ allowedTypes: ['image/png'] }));
    const realCall = caller(appOver(real, filesConfig({ allowedTypes: ['image/png'] })));
    const collection = await insertCollection(run, { default_permission: 'read_write' });
    const page = await insertPage(run, { collection_id: collection });
    const created = (await (await realCall('member', 'POST', '/v1/attachments', { pageId: page, fileName: 'a.png', contentType: 'image/png', size: PNG.length })).json()) as { id: string; upload: { url: string; headers: Record<string, string> } };
    const key = `attachments/${created.id}`;
    const sent = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: PNG });
    expect(sent.status).toBeLessThan(300);
    expect((await realCall('member', 'POST', `/v1/attachments/${created.id}/complete`)).status).toBe(200);
    await expect(real.head(key)).resolves.toMatchObject({ size: PNG.length });
    expect((await realCall('member', 'DELETE', `/v1/pages/${page}`)).status).toBeLessThan(300);
    expect((await realCall('admin', 'DELETE', `/v1/trash/${page}`)).status).toBeLessThan(300);
    await expect(real.head(key)).rejects.toMatchObject({ kind: 'not-found' });
    expect(Number(((await run(`select count(*) as n from attachments where page_id = '${page}'`)) as { n: string }[])[0]?.n)).toBe(0);
  }, 60_000);
});

describe('a purge that the store fails half-way', () => {
  /** Two completed attachments on a page that was deleted; the store refuses to delete the second one while `failing` is set. */
  async function deletedPageWithTwoFiles() {
    const collection = await insertCollection(run, { default_permission: 'read_write' });
    const page = await insertPage(run, { collection_id: collection });
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const made = (await (await call('member', 'POST', '/v1/attachments', { pageId: page, fileName: `f${String(i)}.png`, contentType: 'image/png', size: PNG.length })).json()) as { id: string };
      await files.put(`attachments/${made.id}`, PNG, { size: PNG.length, contentType: 'image/png' });
      expect((await call('member', 'POST', `/v1/attachments/${made.id}/complete`)).status).toBe(200);
      ids.push(made.id);
    }
    expect((await call('member', 'DELETE', `/v1/pages/${page}`)).status).toBeLessThan(300);
    return { page, first: ids[0] as string, second: ids[1] as string };
  }
  let undo: (() => void) | undefined;
  afterEach(() => { undo?.(); undo = undefined; });

  /** The store deletes the first key it is asked for and fails on the second, while `on.failing` is set; `done` lists the keys it removed. */
  const failOnSecond = (on: { failing: boolean }) => {
    const original = files.delete.bind(files);
    const done: string[] = [];
    let calls = 0;
    files.delete = async (key) => {
      calls += 1;
      if (on.failing && calls === 2) throw new Error('store down');
      await original(key);
      done.push(key);
    };
    undo = () => { files.delete = original; };
    return { done };
  };

  it('hides the removed object from a restored page, keeps the other, and a retry of the purge completes', async () => {
    const a = await deletedPageWithTwoFiles();
    const store = failOnSecond({ failing: true });
    expect((await call('admin', 'DELETE', `/v1/trash/${a.page}`)).status).toBe(503);
    const removed = store.done[0]?.replace('attachments/', '') as string;
    const kept = removed === a.first ? a.second : a.first;
    expect(store.done).toHaveLength(1);
    // The object the store removed is marked; the one it did not reach is not.
    const rows = (await run(`select id, deleted_at is not null as gone from attachments where page_id = '${a.page}'`)) as { id: string; gone: boolean }[];
    expect(Object.fromEntries(rows.map((r) => [r.id, r.gone]))).toEqual({ [removed]: true, [kept]: false });
    // A restore of the batch shows an attachment only where its object is still there.
    expect((await call('admin', 'POST', `/v1/trash/${a.page}/restore`)).status).toBeLessThan(300);
    expect((await call('member', 'GET', `/v1/attachments/${kept}`)).status).toBe(200);
    expect((await call('member', 'GET', `/v1/attachments/${removed}`)).status).toBe(404);
  }, 60_000);

  it('can be run again: the retry removes the rest and the page', async () => {
    const b = await deletedPageWithTwoFiles();
    const on = { failing: true };
    failOnSecond(on);
    expect((await call('admin', 'DELETE', `/v1/trash/${b.page}`)).status).toBe(503);
    on.failing = false;
    expect((await call('admin', 'DELETE', `/v1/trash/${b.page}`)).status).toBeLessThan(300);
    for (const id of [b.first, b.second]) await expect(files.head(`attachments/${id}`)).rejects.toMatchObject({ kind: 'not-found' });
    expect(Number(((await run(`select count(*) as n from attachments where page_id = '${b.page}'`)) as { n: string }[])[0]?.n)).toBe(0);
  }, 60_000);
});
