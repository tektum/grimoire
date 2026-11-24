import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessStore, createAttachments, createAudit, createCollections, createDatabase, createIdempotency, createPages, createTrash, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { insertCollection, insertPage, insertUser } from '@tektum/grimoire-test-support/database';
import { createApp } from '../../src/app.js';
import { deleteObjects } from '../../src/attachments/deps.js';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';
import { makeContext } from '../server/support/context.js';

// The real database under the attachment routes, with the in-memory store: what the idempotency table keeps of a create, and that a purge removes the objects.
const DB = 'grimoire_m5t04_attachments';
const FILES = {
  endpoint: 'http://s3.invalid', publicEndpoint: 'http://s3.invalid', publicOrigin: 'http://s3.invalid', bucket: 'b', accessKey: 'a', secretKey: 's', region: 'r',
  addressing: 'path' as const, createOnlyHeader: 'if-none-match' as const, corsMode: 'external' as const, maxBytes: 1000, allowedTypes: ['image/png'], pendingMaxPerUser: 5,
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const run = (sql: string) => sqlAdmin(DB, sql);

let db: KyselyDatabase;
let files: FakeFileStorage;
let call: (who: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
let pageId: string;

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  db = createDatabase(appUrl(DB));
  await insertUser(run, { descope_user_id: 'd-member', email: 'member@example.com', role: 'member' });
  await insertUser(run, { descope_user_id: 'd-admin', email: 'admin@example.com', role: 'admin' });
  const collection = await insertCollection(run, { default_permission: 'read_write' });
  pageId = await insertPage(run, { collection_id: collection });
  const t = makeContext();
  files = new FakeFileStorage({ clock: t.clock });
  const config = makeFakeConfig({ files: FILES, allowedEmailDomains: ['example.com'] });
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const users = createUserStore(db);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], allowDevRole: false };
  const store = createAccessStore(db);
  const app = createApp({
    ...t.ctx, config, auth: { verifier }, signInPolicy,
    http: {
      ...t.ctx.http, config, users, access: createPageAccess(store), authorizer: createAuthorizer(store), provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      idempotency: createIdempotency(db), collections: createCollections(db), audit: createAudit(db), pages: createPages(db), trash: createTrash(db),
      attachments: createAttachments(db), files, deleteFiles: deleteObjects(files),
    },
  });
  call = (who, method, path, body, headers = {}) => app.request(path, {
    method, headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
