import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { v7 } from 'uuid';
import { cleanFileName } from '@tektum/grimoire-core/attachments/file-name';
import { importFailedKey, importZipKey } from '../import/keys.js';
import { cleanItemText } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportItem, ImportRecord } from '@tektum/grimoire-core/ports/import-repo';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import { attachmentDeps } from '../attachments/deps.js';
import { caller, callerTenant, guardCollection } from '../http/collection-guard.js';
import { fail } from '../http/error.js';
import type { AppEnv } from '../http/env.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { guardImport } from '../http/import-guard.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';
import type { ErrorEvents } from '../events.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const ItemParam = IdParam.extend({ itemId: z.string().regex(/^[0-9]{1,18}$/).openapi({ param: { name: 'itemId', in: 'path' } }) });

/** How long the signed address of the zip works: the file may be large and the connection slow (not less than 3,000 seconds). */
const UPLOAD_TTL_SECONDS = 3600;
/** How long the address of a failed original works: it is fetched at once. */
const SOURCE_TTL_SECONDS = 300;
const ZIP_MAGIC = [0x50, 0x4b];

const CreateBody = z
  .object({
    collectionId: z.string().uuid(),
    fileName: z.string().min(1).max(1024).describe('The name of the zip as the person has it; shown nowhere, kept nowhere'),
    size: z.number().int().positive().describe('Bytes of the zip; not above the largest zip an import takes'),
  })
  .strict()
  .openapi('CreateImport');
const Upload = z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string().describe('ISO 8601') }).openapi('ImportUpload');
const Created = z.object({ id: z.string().uuid(), upload: Upload }).openapi('ImportCreated');
const Status = z.enum(['created', 'uploaded', 'running', 'done', 'failed', 'cancelled']);
const State = z
  .object({
    status: Status,
    counts: z.object({ pagesTotal: z.number().int(), pagesDone: z.number().int(), attachments: z.number().int(), skipped: z.number().int(), failed: z.number().int() }),
    startedAt: z.string().nullable().describe('ISO 8601; null until the import starts'),
    finishedAt: z.string().nullable().describe('ISO 8601; null until it ends'),
    error: z.string().nullable().describe('A code, never text, for a failed import'),
  })
  .openapi('ImportState');
const Item = z
  .object({
    id: z.string(),
    path: z.string().describe('The path of the file in the zip, at most 300 characters, without control characters'),
    kind: z.enum(['page', 'attachment', 'database_csv', 'other']),
    pageId: z.string().uuid().nullable(),
    status: z.enum(['ok', 'skipped', 'failed']),
    message: z.string().nullable().describe('For a skipped or failed file, the code of the reason (at most 300 characters, never a path)'),
    markdownBytes: z.number().int().nullable(),
    stateBytes: z.number().int().nullable(),
    hasSource: z.boolean().describe('True for a failed page whose original Markdown is kept'),
  })
  .openapi('ImportItem');
const Items = z.object({ items: z.array(Item), nextCursor: z.string().nullable() }).openapi('ImportItems');
const Started = z.object({ status: z.literal('uploaded').describe('The import waits for its turn: the job moves it to `running` (one import of a workspace runs at a time)') }).openapi('ImportStarted');
const Source = z.object({ url: z.string(), expiresAt: z.string().describe('ISO 8601') }).openapi('ImportSource');

export const createImport = defineRoute({
  method: 'post', path: '/v1/imports', operationId: 'createImport', summary: 'Make an import: a signed address to PUT the zip to', tags: ['imports'],
  policy: { kind: 'collection-body', field: 'collectionId', need: 'write' }, rateLimit: { max: 10, windowSeconds: 3600 },
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: json(Created, 'The import and where to PUT the zip (the address works for an hour)'),
    404: json(ErrorBody, 'No such collection, or not one the caller can see'),
    413: json(ErrorBody, 'Larger than the largest zip an import takes'),
    422: json(ErrorBody, 'Not a valid request'),
    429: json(ErrorBody, 'Too many imports were made'),
    503: json(ErrorBody, 'The file store is not configured or does not answer'),
  },
});

export const startImport = defineRoute({
  method: 'post', path: '/v1/imports/{id}/start', operationId: 'startImport', summary: 'Start an import after the zip was sent', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator' },
  request: { params: IdParam },
  responses: {
    202: json(Started, 'The import is accepted and its job queued'),
    404: json(ErrorBody, 'Not found, not the caller\'s, or the caller can no longer write in the collection'),
    409: json(ErrorBody, '`upload_missing`, `size_mismatch` or `already_started`'),
    422: json(ErrorBody, '`not_a_zip`: the file is not a zip archive'),
    503: json(ErrorBody, 'The file store does not answer, or the job queue is not up'),
  },
});

export const getImport = defineRoute({
  method: 'get', path: '/v1/imports/{id}', operationId: 'getImport', summary: 'Where an import is', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator-or-admin' },
  request: { params: IdParam },
  responses: { 200: json(State, 'The state and the counts'), 404: json(ErrorBody, 'Not found or not the caller\'s') },
});

export const listImportItems = defineRoute({
  method: 'get', path: '/v1/imports/{id}/items', operationId: 'listImportItems', summary: 'The report of an import: what became of each file that is settled', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator-or-admin' },
  request: { params: IdParam, query: paginationQuery },
  responses: {
    200: json(Items, 'A page of the report, in ascending id'),
    404: json(ErrorBody, 'Not found or not the caller\'s'),
    422: json(ErrorBody, 'A cursor this list did not issue'),
    503: json(ErrorBody, 'The file store does not answer'),
  },
});

export const getImportItemSource = defineRoute({
  method: 'get', path: '/v1/imports/{id}/items/{itemId}/source', operationId: 'getImportItemSource', summary: 'A short-lived address to download the original Markdown of a failed page', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator-or-admin' },
  request: { params: ItemParam },
  responses: { 200: json(Source, 'The address (a download, never shown in the page)'), 404: json(ErrorBody, 'No such item, or it has no kept original'), 503: json(ErrorBody, 'The file store is not configured or does not answer') },
});

export const cancelImport = defineRoute({
  method: 'post', path: '/v1/imports/{id}/cancel', operationId: 'cancelImport', summary: 'Cancel a running import', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator-or-admin' },
  request: { params: IdParam },
  responses: { 200: json(State, 'The import is cancelled (its pages are moved to the trash)'), 404: json(ErrorBody, 'Not found or not the caller\'s'), 409: json(ErrorBody, '`not_running`') },
});

type Ctx = Context<AppEnv>;
type Operation = ErrorEvents['files.unavailable']['operation'];

/** The file routes need a store; without one they answer 503 and the rest of the server keeps working. */
function store(c: Ctx, operation: Operation): FileStorage {
  const d = attachmentDeps(c.get('deps'));
  if (d === undefined) {
    c.get('deps').log.error('files.unavailable', { operation });
    return fail('unavailable');
  }
  return d.deps.files;
}

/** A store that does not answer is 503, logged without the store's own message. */
async function viaStore<T>(c: Ctx, operation: Operation, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof FileStorageError)) throw error;
    c.get('deps').log.error('files.unavailable', { operation });
    return fail('unavailable');
  }
}

/** The same, for a look at an object that may not be there: that is `undefined`, the caller's to read. */
const ifThere = <T>(c: Ctx, operation: Operation, run: () => Promise<T>): Promise<T | undefined> =>
  viaStore(c, operation, () => run().catch((error: unknown) => (error instanceof FileStorageError && error.kind === 'not-found' ? undefined : Promise.reject(error))));

const noStore = (c: Ctx): void => {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const present = (r: ImportRecord) => ({
  status: r.status,
  counts: { pagesTotal: r.counts.pagesTotal, pagesDone: r.counts.pagesDone, attachments: r.counts.attachments, skipped: r.counts.skipped, failed: r.counts.failed },
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  error: r.error,
});

async function firstBytes(files: FileStorage, key: string, n: number): Promise<number[]> {
  const out: number[] = [];
  const { body } = await files.get(key, { range: { start: 0, end: n - 1 } });
  for await (const chunk of body) out.push(...chunk);
  return out;
}

const router = createRouter();

router.openapi(createImport, async (c) => {
  const user = caller(c);
  const tenant = callerTenant(c);
  const body = c.req.valid('json');
  await guardCollection(c, body.collectionId, 'write');
  const { config, imports, log } = c.get('deps');
  if (body.size > config.import.maxZipBytes) return fail('too_large');
  const files = store(c, 'import-create');
  const id = v7();
  const key = importZipKey(tenant, id);
  const upload = await viaStore(c, 'import-create', () => files.signUpload(key, { size: body.size, contentType: 'application/zip', ttlSeconds: UPLOAD_TTL_SECONDS, ifNoneMatch: true }));
  await imports.create(tenant, { id, targetCollectionId: body.collectionId, createdBy: user.id, source: 'markdown_zip', bytes: body.size, s3Key: key });
  log.info('import.created', { importId: id });
  noStore(c);
  return c.json({ id, upload: { ...upload, expiresAt: new Date(upload.expiresAt).toISOString() } }, 201);
});

router.openapi(startImport, async (c) => {
  const user = caller(c);
  const tenant = callerTenant(c);
  const { id } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator');
  const deps = c.get('deps');
  // Write access to the target collection is checked again now: a person who has lost it finds no such import.
  const decision = (await deps.collections.get(tenant, record.targetCollectionId)) === undefined ? undefined : await deps.authorizer.checkCollection({ userId: user.id, collectionId: record.targetCollectionId });
  if (decision?.access !== 'read-write') return fail('not_found');
  if (record.status !== 'created' && record.status !== 'uploaded') return fail('already_started');
  const files = store(c, 'import-start');
  const key = record.s3Key ?? importZipKey(tenant, id);
  const head = await ifThere(c, 'import-start', () => files.head(key));
  if (head === undefined) return fail('upload_missing');
  if (head.size !== record.bytes) return fail('size_mismatch');
  const magic = await ifThere(c, 'import-start', () => firstBytes(files, key, 2));
  if (magic === undefined) return fail('upload_missing');
  if (magic[0] !== ZIP_MAGIC[0] || magic[1] !== ZIP_MAGIC[1]) return fail('not_a_zip');
  if (!(await deps.imports.markUploaded(tenant, id))) return fail('already_started');
  // The job moves the import to `running` when its turn comes: a workspace has one running import at a time, held by the database, so a second one waits as `uploaded` and its job tries again.
  try {
    await deps.enqueueImport({ importId: id, tenantId: tenant }, { singletonKey: id });
  } catch {
    // The work could not be queued: the import stays `uploaded`, and the person may start it again.
    deps.log.error('files.unavailable', { operation: 'import-start' });
    return fail('unavailable');
  }
  await deps.audit.append({ actorId: user.id, action: 'import.started', targetType: 'import', targetId: id, tenantId: tenant, detail: { bytes: record.bytes } });
  deps.log.info('import.started', { importId: id });
  noStore(c);
  return c.json({ status: 'uploaded' as const }, 202);
});

router.openapi(getImport, async (c) => {
  const { id } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator-or-admin');
  noStore(c);
  return c.json(present(record), 200);
});

const itemOf = (item: ImportItem, hasSource: boolean) => ({
  id: item.id,
  path: cleanItemText(item.path),
  kind: item.kind,
  pageId: item.pageId,
  status: item.status as 'ok' | 'skipped' | 'failed',
  message: item.message,
  markdownBytes: item.markdownBytes,
  stateBytes: item.stateBytes,
  hasSource,
});

router.openapi(listImportItems, async (c) => {
  const tenant = callerTenant(c);
  const { id } = c.req.valid('param');
  const { limit, cursor } = c.req.valid('query');
  await guardImport(c, id, 'creator-or-admin');
  const keys = decodeCursor('import-items', cursor, 1);
  if (keys !== undefined && !/^[0-9]{1,18}$/.test(String(keys[0]))) return fail('invalid');
  const rows = await c.get('deps').imports.listItems(tenant, id, { limit: limit + 1, ...(keys === undefined ? {} : { afterId: String(keys[0]) }) });
  const page = toPage('import-items', rows, limit, (row) => [row.id]);
  // A failed page has a source to download when its original was kept: one look at the store for each such item of this page.
  const files = attachmentDeps(c.get('deps'))?.deps.files;
  const withSource = new Set<string>();
  if (files !== undefined) {
    const failedPages = page.items.filter((i) => i.status === 'failed' && i.kind === 'page');
    const kept = await Promise.all(failedPages.map((i) => ifThere(c, 'import-items', () => files.head(importFailedKey(tenant, id, i.id)))));
    failedPages.forEach((i, n) => { if (kept[n] !== undefined) withSource.add(i.id); });
  }
  noStore(c);
  return c.json({ items: page.items.map((i) => itemOf(i, withSource.has(i.id))), nextCursor: page.nextCursor }, 200);
});

router.openapi(getImportItemSource, async (c) => {
  const tenant = callerTenant(c);
  const { id, itemId } = c.req.valid('param');
  await guardImport(c, id, 'creator-or-admin');
  const item = await c.get('deps').imports.getItem(tenant, id, itemId);
  if (item === undefined || item.status !== 'failed' || item.kind !== 'page') return fail('not_found');
  const files = store(c, 'import-source');
  const key = importFailedKey(tenant, id, itemId);
  if ((await ifThere(c, 'import-source', () => files.head(key))) === undefined) return fail('not_found');
  const parts = cleanItemText(item.path).split('/');
  const link = await viaStore(c, 'import-source', () => files.signDownload(key, { ttlSeconds: SOURCE_TTL_SECONDS, disposition: 'attachment', fileName: cleanFileName(parts[parts.length - 1] as string), contentType: 'application/octet-stream' }));
  noStore(c);
  return c.json({ url: link.url, expiresAt: new Date(link.expiresAt).toISOString() }, 200);
});

router.openapi(cancelImport, async (c) => {
  const user = caller(c);
  const tenant = callerTenant(c);
  const { id } = c.req.valid('param');
  await guardImport(c, id, 'creator-or-admin');
  const deps = c.get('deps');
  const cancelled = await deps.imports.cancel(tenant, id, deps.clock.now());
  if (cancelled === undefined) return fail('not_running');
  await deps.audit.append({ actorId: user.id, action: 'import.cancelled', targetType: 'import', targetId: id, tenantId: tenant });
  deps.log.info('import.cancelled', { importId: id });
  noStore(c);
  return c.json(present(cancelled), 200);
});

export default router;
