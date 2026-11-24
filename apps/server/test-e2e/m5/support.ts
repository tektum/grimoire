import './results.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { createApiClient } from '@tektum/grimoire-api-client';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createFileStorage } from '@tektum/grimoire-adapter-files-s3';
import type { S3FileStorage } from '@tektum/grimoire-adapter-files-s3';
import { PEOPLE, apiAs, errorCode, expectStatus, scenario, signInAll, unique } from '../m4/support.ts';
import type { Person, T } from '../m4/support.ts';
import { BASE, compose, devToken, eventually, repoRoot } from '../support.ts';
import { filesConfig, publicEndpoint } from './browser/support.ts';

// Helpers of the milestone 5 end-to-end test (`make test-m5`). Every request to the application goes through the generated client (as in M4); the only hand-written
// requests are the transfers to and from the file store with the signed addresses the application gave, and they are written here and nowhere else.
export { PEOPLE, apiAs, errorCode, eventually, expectStatus, publicEndpoint, scenario, signInAll, unique };

/** The origin the application signs addresses for: the value `make test-m5` starts it with (the store as the host reaches it). */
export const signedEndpoint = setting('GRIMOIRE_S3_PUBLIC_ENDPOINT', 'http://127.0.0.1:8333');
export type { Person, T };

/** A client for any development identity, not only the three people (a fresh name is a fresh user, with its own pending uploads). */
export const apiFor = (name: string, role: 'member' | 'admin' | 'viewer' = 'member') => createApiClient({ baseUrl: BASE, getToken: () => devToken(name, role) });
export type Api = ReturnType<typeof apiFor>;

/** The store as the server uses it: the runtime identity, and its signed addresses for the public endpoint. */
export const runtimeStore = (bucket?: string): S3FileStorage => createFileStorage({ ...filesConfig(), ...(bucket === undefined ? {} : { bucket }) });

/** What `.env` (written by `make`) or the environment says: the admin identity of the store belongs to the set-up step and this test only. */
export function setting(name: string, fallback?: string): string {
  const file = path.join(repoRoot, '.env');
  const fromFile = existsSync(file) ? new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]?.trim() : undefined;
  const value = process.env[name] ?? fromFile ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set: run \`make up\` to write .env`);
  return value;
}

/** The first bytes of a PNG followed by random bytes: a file of the declared type, different every run. */
/** A real, minimal PNG (1 by 1 pixel) padded to a chosen size with an ancillary text chunk. The application sniffs the first bytes, so random bytes after the signature are not a PNG. */
export const pngBytes = (extra = 64): Uint8Array => {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8 bits, grayscale, no interlace
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.concat([Buffer.from('pad\0', 'latin1'), randomBytes(extra)])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]));
};
export const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** SQL as the administrator role in the PostgreSQL container; the answer is the unaligned rows. */
export const sql = (query: string): Promise<string> => compose('exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', query);

/** The runtime role's connection, for what the application's own code does (the clean-up). */
export const runtimeDatabase = () => createDatabase(`postgresql://grimoire_app:${setting('GRIMOIRE_DEV_DB_PASSWORD', 'grimoire-dev')}@127.0.0.1:55432/grimoire`, { maxConnections: 2 });

/** Throws unless the answer is a success; returns its body. */
export function succeeded<D>(answer: { readonly data?: D; readonly error?: unknown; readonly response: Response }, what: string): D {
  if (answer.response.status >= 300) throw new Error(`${what}: got ${String(answer.response.status)} ${JSON.stringify(answer.error ?? null)}`);
  return answer.data as D;
}

/** A collection and a page in it. `open`: everyone may write in it; otherwise nobody but the administrator can even see it. */
export async function pageIn(open: boolean): Promise<{ readonly collection: string; readonly page: string }> {
  const alice = apiAs('alice');
  const made = expectStatus(await alice.POST('/v1/collections', { body: { name: unique(open ? 'Exit M5 open' : 'Exit M5 private') } }), 201, 'the administrator creates a collection');
  if (open) succeeded(await alice.PATCH('/v1/collections/{id}', { params: { path: { id: made.id } }, body: { defaultPermission: 'read_write' } }), 'everyone may write in it');
  const page = expectStatus(await alice.POST('/v1/pages', { body: { collectionId: made.id, title: unique('Page') } }), 201, 'the administrator creates a page');
  return { collection: made.id, page: page.id };
}

/** The start of an upload: the attachment and the signed address, as the application answered. */
export async function startUpload(api: Api, pageId: string, bytes: Uint8Array, over: { fileName?: string; contentType?: string; size?: number; key?: string } = {}) {
  const answer = await api.POST('/v1/attachments', {
    body: { pageId, fileName: over.fileName ?? `file ${randomUUID().slice(0, 8)}.png`, contentType: over.contentType ?? 'image/png', size: over.size ?? bytes.length },
    ...(over.key === undefined ? {} : { headers: { 'idempotency-key': over.key } }),
  });
  return { answer, body: answer.data };
}
export type Started = NonNullable<Awaited<ReturnType<typeof startUpload>>['body']>;

/** The transfer to the store with the signed address: the headers the application gave, unless told otherwise. */
export const sendToStore = (upload: Started['upload'], body: Uint8Array, headers: Record<string, string> = upload.headers): Promise<Response> => fetch(upload.url, { method: 'PUT', headers, body });
/** The transfer from the store with a download link. */
export const getFromStore = (url: string): Promise<Response> => fetch(url);

/** Created, sent and completed: a ready attachment on `pageId`. */
export async function readyAttachment(api: Api, pageId: string, bytes: Uint8Array, over: { fileName?: string; contentType?: string } = {}): Promise<Started> {
  const started = (await startUpload(api, pageId, bytes, over)).body;
  if (started === undefined) throw new Error('the upload was not started');
  const sent = await sendToStore(started.upload, bytes);
  if (!sent.ok) throw new Error(`the store refused the upload: ${String(sent.status)}`);
  succeeded(await api.POST('/v1/attachments/{id}/complete', { params: { path: { id: started.id } } }), 'complete');
  return started;
}

/** Whether the store has the object of an attachment (the runtime identity looks). */
export const objectExists = (id: string): Promise<boolean> => runtimeStore().head(`attachments/${id}`).then(() => true, (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'not-found') return false;
  throw error;
});
