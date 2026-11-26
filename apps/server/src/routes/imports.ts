import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { v7 } from 'uuid';
import { cleanFileName } from '@tektum/grimoire-core/attachments/file-name';
import { importFailedKey, importPartKey, importZipKey } from '../import/keys.js';
import { cleanItemText, CONSTRUCT_FATES, MAX_REPORT_PAGES, StagingQuotaError } from '@tektum/grimoire-core/ports/import-repo';
import type { ConstructKind, ConstructReport, ImportItem, ImportRecord, NewImportPart, ReportPage } from '@tektum/grimoire-core/ports/import-repo';
import { FileStorageError, MAX_PARTS } from '@tektum/grimoire-core/ports/file-storage';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import { attachmentDeps } from '../attachments/deps.js';
import { caller, callerTenant, guardCollection } from '../http/collection-guard.js';
import { fail } from '../http/error.js';
import type { AppEnv } from '../http/env.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { guardImport } from '../http/import-guard.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';
import { ZIP_MAGIC } from '../import/zip-reader.js';
import { cutParts, partLength, planUpload, sizingOf } from '../import/upload-plan.js';
import { importSingletonKey } from '../jobs/types.js';
import type { ErrorEvents } from '../events.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const ItemParam = IdParam.extend({ itemId: z.string().regex(/^[0-9]{1,18}$/).openapi({ param: { name: 'itemId', in: 'path' } }) });

/** How long the signed address of the zip works: the file may be large and the connection slow (not less than 3,000 seconds). */
const UPLOAD_TTL_SECONDS = 3600;
/** How long the address of a failed original works: it is fetched at once. */
const SOURCE_TTL_SECONDS = 300;
/** How long the signed address of one part works: a part is sent at once, and the page asks for more addresses as it goes. */
const PART_TTL_SECONDS = 900;
/** The most addresses one request gives. */
const MAX_PART_URLS = 50;
/** The most zips a request may list whatever the settings say (the schema is fixed): the number of an import is `maxZips`, checked on the request. */
const MAX_FILES_CEILING = 64;

const CreateBody = z
  .object({
    collectionId: z.string().uuid(),
    files: z
      .array(
        z
          .object({
            fileName: z.string().min(1).max(1024).describe('The name of the zip as the person has it; shown nowhere, kept nowhere'),
            size: z.number().int().positive().describe('Bytes of the zip; not above the largest zip an import takes'),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FILES_CEILING)
      .describe('The zips of the import, in the order they are read'),
    profile: z.enum(['markdown_zip', 'notion_md_csv']).optional().describe('How the archive is read: `notion_md_csv` for an export of Notion (Markdown and CSV files), `markdown_zip` (the default) for any other zip of Markdown files'),
  })
  .strict()
  .openapi('CreateImport');
const Upload = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('single'), method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string().describe('ISO 8601') }),
    z.object({ kind: z.literal('multipart'), partSize: z.number().int().describe('Bytes of every part but the last, which is what is left of the file'), partCount: z.number().int() }),
  ])
  .openapi('ImportUpload');
const Created = z.object({ id: z.string().uuid(), uploads: z.array(z.object({ index: z.number().int().describe('The place of the file in the request, from 0'), upload: Upload })) }).openapi('ImportCreated');
const PartParam = IdParam.extend({ index: z.string().regex(/^[0-9]{1,3}$/).openapi({ param: { name: 'index', in: 'path' } }) });
const PartUrlsBody = z
  .object({ partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(MAX_PART_URLS).describe('The parts to sign, from 1 to the part count of the file, each once') })
  .strict()
  .openapi('ImportPartUrlsRequest');
const PartUrls = z
  .object({ urls: z.array(z.object({ partNumber: z.number().int(), method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string().describe('ISO 8601') })) })
  .openapi('ImportPartUrls');
const PartList = z
  .object({
    partSize: z.number().int(),
    partCount: z.number().int(),
    parts: z.array(z.object({ partNumber: z.number().int(), size: z.number().int() })).describe('The parts the store holds, in ascending number'),
  })
  .openapi('ImportPartList');
const Status = z.enum(['created', 'uploaded', 'running', 'done', 'failed', 'cancelled']);
const CONSTRUCT_KINDS = Object.keys(CONSTRUCT_FATES) as [ConstructKind, ...ConstructKind[]];
const ReportPageBody = z.object({
  itemId: z.string(),
  path: z.string().describe('The path of the file in the zip, at most 300 characters, without control characters'),
  urlId: z.string().nullable().describe('The id the page has in the address (`/p/<urlId>`); null for a row that was left out'),
});
const ConstructLine = z.object({
  kind: z.enum(CONSTRUCT_KINDS).describe('callout and toggle, page_mention (a link now pointing at the imported page), database_table: converted; front_matter, icon_cover, database_row: dropped; unresolved_link (a link that matched nothing, left as written) and raw_html: kept'),
  fate: z.enum(['converted', 'dropped', 'kept']),
  count: z.number().int().describe('How many times it occurred in the pages that were written'),
  pages: z.array(ReportPageBody).max(MAX_REPORT_PAGES).describe('The first pages that hold it, by file order'),
  capped: z.boolean().describe('True when more pages hold it than are named'),
});
const Report = z
  .object({
    constructs: z.array(ConstructLine),
    rawHtmlPages: z.array(ReportPageBody.extend({ fragments: z.number().int() })).max(MAX_REPORT_PAGES).describe('Pages that still hold HTML, with the number of fragments, so that someone can clean them up'),
    rawHtmlCapped: z.boolean(),
  })
  .openapi('ImportConstructReport');
const State = z
  .object({
    status: Status,
    counts: z.object({ pagesTotal: z.number().int(), pagesDone: z.number().int(), attachments: z.number().int(), skipped: z.number().int(), failed: z.number().int() }),
    startedAt: z.string().nullable().describe('ISO 8601; null until the import starts'),
    finishedAt: z.string().nullable().describe('ISO 8601; null until it ends'),
    error: z.string().nullable().describe('A code, never text, for a failed import'),
    report: Report.describe('What the import did to the constructs of the pages written so far: converted, dropped and kept ones, counted (empty before anything is written)'),
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
    hasSource: z.boolean().describe('True for a failed page or database whose original file is kept'),
    remoteImageFailures: z
      .record(z.string(), z.number().int())
      .describe(
        'Remote pictures of the page that were not copied: a count for each reason code (blocked_address, redirect, too_large, timeout, status, type, budget, network, scheme, not_fetched, empty, size_mismatch), never an address; {} when there are none. A code a client does not know is still a reason.',
      ),
  })
  .openapi('ImportItem');
const Items = z.object({ items: z.array(Item), nextCursor: z.string().nullable() }).openapi('ImportItems');
const Started = z.object({ status: z.literal('uploaded').describe('The import waits for its turn: the job moves it to `running` (one import of a workspace runs at a time)') }).openapi('ImportStarted');
const Source = z.object({ url: z.string(), expiresAt: z.string().describe('ISO 8601') }).openapi('ImportSource');

export const createImport = defineRoute({
  method: 'post', path: '/v1/imports', operationId: 'createImport', summary: 'Make an import: where to send each zip (a signed PUT, or a multipart upload sent part by part)', tags: ['imports'],
  policy: { kind: 'collection-body', field: 'collectionId', need: 'write' }, rateLimit: { max: 10, windowSeconds: 3600 },
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: json(Created, 'The import and where to send each file: one signed PUT (it works for an hour), or the part size and count of a multipart upload (ask for the addresses of the parts)'),
    404: json(ErrorBody, 'No such collection, or not one the caller can see'),
    413: json(ErrorBody, 'Larger than the largest zip an import takes'),
    422: json(ErrorBody, 'Not a valid request'),
    429: json(ErrorBody, 'Too many imports were made (`rate_limited`), or the workspace holds as many bytes of unfinished uploads as it may (`staging_quota`)'),
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
    409: json(ErrorBody, '`upload_missing`, `size_mismatch`, `part_missing` (a part of a multipart upload is not there) or `already_started`'),
    422: json(ErrorBody, '`not_a_zip`: the file does not start as a zip archive'),
    503: json(ErrorBody, 'The file store does not answer, or the job queue is not up'),
  },
});

export const createImportPartUrls = defineRoute({
  method: 'post', path: '/v1/imports/{id}/parts/{index}/urls', operationId: 'createImportPartUrls', summary: 'Signed addresses to PUT parts of a file that goes up in parts', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator' }, rateLimit: { max: 120, windowSeconds: 3600 },
  request: { params: PartParam, body: { required: true, content: { 'application/json': { schema: PartUrlsBody } } } },
  responses: {
    200: json(PartUrls, 'One address for each part asked, valid for 15 minutes, signed for the exact length of the part'),
    404: json(ErrorBody, 'Not found, not the caller\'s, or the file is not one that goes up in parts'),
    409: json(ErrorBody, '`already_started`'),
    422: json(ErrorBody, 'More than 50 parts, a part that is not in the file, or one asked twice'),
    429: json(ErrorBody, 'Too many requests'),
    503: json(ErrorBody, 'The file store does not answer'),
  },
});

export const listImportParts = defineRoute({
  method: 'get', path: '/v1/imports/{id}/parts/{index}', operationId: 'listImportParts', summary: 'The parts of a file the store holds, to go on with an upload after a reload', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator' },
  request: { params: PartParam },
  responses: {
    200: json(PartList, 'How the file is cut and which parts the store holds'),
    404: json(ErrorBody, 'Not found, not the caller\'s, or the file is not one that goes up in parts'),
    409: json(ErrorBody, '`already_started`, or `upload_missing` (the store no longer has the upload)'),
    503: json(ErrorBody, 'The file store does not answer'),
  },
});

export const abortImport = defineRoute({
  method: 'post', path: '/v1/imports/{id}/abort', operationId: 'abortImport', summary: 'Give up an upload that was not started', tags: ['imports'],
  policy: { kind: 'import', param: 'id', who: 'creator' },
  request: { params: IdParam },
  responses: {
    200: json(State, 'The import is abandoned; its zips are deleted and its multipart uploads ended by the cleanup'),
    404: json(ErrorBody, 'Not found or not the caller\'s'),
    409: json(ErrorBody, '`already_started`: use cancel for an import that was started'),
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
  method: 'get', path: '/v1/imports/{id}/items/{itemId}/source', operationId: 'getImportItemSource', summary: 'A short-lived address to download the original file of a failed page or database', tags: ['imports'],
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

/** The first four bytes of the object. */
async function signature(files: FileStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await files.get(key, { range: { start: 0, end: 3 } })).body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const router = createRouter();

router.openapi(createImport, async (c) => {
  const user = caller(c);
  const tenant = callerTenant(c);
  const body = c.req.valid('json');
  await guardCollection(c, body.collectionId, 'write');
  const { config, imports, log } = c.get('deps');
  // What one import takes: how many zips, the size of each and of all of them (a person who is over any of these is told before a byte is sent).
  if (body.files.length > config.import.maxZips || body.files.some((file) => file.size > config.import.maxZipBytes) || body.files.reduce((sum, file) => sum + file.size, 0) > config.import.maxTotalBytes) return fail('too_large');
  const files = store(c, 'import-create');
  const sizing = sizingOf(config.import);
  const id = v7();
  const opened: { key: string; uploadId: string }[] = [];
  try {
    // Every call to the store comes first and the row is one write after them: a failure leaves no row, and the multipart uploads already opened are ended below.
    const uploads = await viaStore(c, 'import-create', async () => {
      const made: { part: NewImportPart; upload: z.infer<typeof Upload> }[] = [];
      for (const [index, file] of body.files.entries()) {
        const key = importPartKey(tenant, id, index);
        const plan = planUpload(file.size, sizing);
        if (plan.kind === 'single') {
          const signed = await files.signUpload(key, { size: file.size, contentType: 'application/zip', ttlSeconds: UPLOAD_TTL_SECONDS, ifNoneMatch: true });
          made.push({ part: { s3Key: key, bytes: file.size, uploadId: null }, upload: { kind: 'single', ...signed, expiresAt: new Date(signed.expiresAt).toISOString() } });
        } else {
          const { uploadId } = await files.createMultipart(key, { contentType: 'application/zip' });
          opened.push({ key, uploadId });
          made.push({ part: { s3Key: key, bytes: file.size, uploadId }, upload: { kind: 'multipart', partSize: plan.partSize, partCount: plan.partCount } });
        }
      }
      return made;
    });
    await imports.create(tenant, { id, targetCollectionId: body.collectionId, createdBy: user.id, source: body.profile ?? 'markdown_zip', parts: uploads.map((u) => u.part), stagedQuotaBytes: config.import.stagedQuotaBytes });
    log.info('import.created', { importId: id });
    noStore(c);
    return c.json({ id, uploads: uploads.map((u, index) => ({ index, upload: u.upload })) }, 201);
  } catch (error) {
    // Nothing was made: end the uploads that were opened (when the store does not answer, its own lifecycle rule ends them).
    await Promise.allSettled(opened.map((o) => files.abortMultipart(o.key, o.uploadId)));
    // The workspace holds as many bytes of unfinished uploads as it may: the import is not made (its signed addresses were not used; the sessions are ended above).
    if (error instanceof StagingQuotaError) return fail('staging_quota');
    throw error;
  }
});

router.openapi(startImport, async (c) => {
  const user = caller(c);
  const tenant = callerTenant(c);
  const { id } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator');
  const deps = c.get('deps');
  // Write access to the target collection is checked again now: a person who has lost it finds no such import.
  const decision = (await deps.collections.get(tenant, record.targetCollectionId)) === undefined ? undefined : await deps.authorizer.checkCollection({ tenantId: tenant, userId: user.id, collectionId: record.targetCollectionId });
  if (decision?.access !== 'read-write') return fail('not_found');
  if (record.status !== 'created' && record.status !== 'uploaded') return fail('already_started');
  const files = store(c, 'import-start');
  const stored = await deps.imports.parts(tenant, id);
  // A row with no part (one that does not keep its key) has one zip, at the conventional key, as the job reads it.
  const parts = stored.length > 0 ? stored : record.bytes === null ? [] : [{ ordinal: 0, s3Key: record.s3Key ?? importZipKey(tenant, id), bytes: record.bytes, uploadId: null }];
  if (parts.length === 0) return fail('upload_missing');
  const { partBytes } = sizingOf(deps.config.import);
  for (const part of parts) {
    const { uploadId } = part;
    if (uploadId !== null) {
      // A file that went up in parts is joined here, from the parts the store holds (the page never handles an ETag): all of them, each of its exact length, or `part_missing`.
      const held = await ifThere(c, 'import-start', () => files.listParts(part.s3Key, uploadId));
      if (held === undefined) {
        // The upload is gone: an earlier start joined it and did not get to write that down (or the store dropped it). The object says which.
        const joined = await ifThere(c, 'import-start', () => files.head(part.s3Key));
        if (joined?.size !== part.bytes) return fail('upload_missing');
      } else {
        const { partSize, partCount } = cutParts(part.bytes, partBytes);
        if (held.length !== partCount || held.some((h, n) => h.partNumber !== n + 1 || h.size !== partLength(part.bytes, partSize, n + 1))) return fail('part_missing');
        await viaStore(c, 'import-start', () => files.completeMultipart(part.s3Key, uploadId));
      }
      await deps.imports.closePart(tenant, id, part.ordinal);
    }
    const head = await ifThere(c, 'import-start', () => files.head(part.s3Key));
    if (head === undefined) return fail('upload_missing');
    if (head.size !== part.bytes) return fail('size_mismatch');
    // Only the signature the archive reader requires (four bytes): the central directory and the header checks are the job's first stage, where the work is bounded by the workers of the
    // queue, and not a request's, which a person can repeat at will. A zip the reader refuses there ends the import as failed, with its code.
    const first = await ifThere(c, 'import-start', () => signature(files, part.s3Key));
    if (first === undefined) return fail('upload_missing');
    if (!ZIP_MAGIC.some((m) => first.equals(m))) return fail('not_a_zip');
  }
  if (!(await deps.imports.markUploaded(tenant, id))) return fail('already_started');
  // Accepted: audited once, by the start that moved it from `created`; asking again while it waits (or after the job could not be queued) is a retry, not another start.
  if (record.status === 'created') await deps.audit.append({ actorId: user.id, action: 'import.started', targetType: 'import', targetId: id, tenantId: tenant, detail: { bytes: record.bytes } });
  // The job moves the import to `running` when its turn comes: a workspace has one running import at a time, held by the database, so a second one waits as `uploaded` and its job tries again.
  try {
    await deps.enqueueImport({ importId: id, tenantId: tenant }, { singletonKey: importSingletonKey(id) });
  } catch {
    // The work could not be queued: the import stays `uploaded`, and the person may start it again.
    deps.log.error('files.unavailable', { operation: 'import-enqueue' });
    return fail('unavailable');
  }
  deps.log.info('import.started', { importId: id });
  noStore(c);
  return c.json({ status: 'uploaded' as const }, 202);
});

/** What the report is when the import is gone between the guard and the read (a purge): nothing was converted, dropped or kept. */
const NO_REPORT: ConstructReport = { constructs: [], rawHtmlPages: [], rawHtmlCapped: false };
/** The state of an import with its construct report, as `getImport` and `cancelImport` both answer it. */
async function stateOf(c: Context<AppEnv>, record: ImportRecord) {
  const report = (await c.get('deps').imports.constructReport(record.tenantId, record.id)) ?? NO_REPORT;
  const page = (p: ReportPage): ReportPage => ({ itemId: p.itemId, path: cleanItemText(p.path), urlId: p.urlId });
  return { ...present(record), report: { constructs: report.constructs.map((l) => ({ ...l, pages: l.pages.map(page) })), rawHtmlPages: report.rawHtmlPages.map((p) => ({ ...page(p), fragments: p.fragments })), rawHtmlCapped: report.rawHtmlCapped } };
}
router.openapi(getImport, async (c) => {
  const { id } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator-or-admin');
  const state = await stateOf(c, record);
  noStore(c);
  return c.json(state, 200);
});

/** A reason code is lower-case words with underscores and a count is a whole number from 1: anything else (a key that could carry an address) is not passed on. */
const REASON_CODE = /^[a-z][a-z_]{0,31}$/;
const failuresOf = (failures: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(failures).filter(([code, n]) => REASON_CODE.test(code) && Number.isSafeInteger(n) && n > 0));

/** The kinds of file whose original is kept when it fails, to be downloaded from the report: a page, and a database's CSV. */
const keepsOriginal = (kind: ImportItem['kind']): boolean => kind === 'page' || kind === 'database_csv';

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
  remoteImageFailures: failuresOf(item.remoteImageFailures),
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
  // A failed page or database has a source to download when its original was kept: one look at the store for each such item of this page.
  const files = attachmentDeps(c.get('deps'))?.deps.files;
  const withSource = new Set<string>();
  if (files !== undefined) {
    const failed = page.items.filter((i) => i.status === 'failed' && keepsOriginal(i.kind));
    const kept = await Promise.all(failed.map((i) => ifThere(c, 'import-items', () => files.head(importFailedKey(tenant, id, i.id)))));
    failed.forEach((i, n) => { if (kept[n] !== undefined) withSource.add(i.id); });
  }
  noStore(c);
  return c.json({ items: page.items.map((i) => itemOf(i, withSource.has(i.id))), nextCursor: page.nextCursor }, 200);
});

router.openapi(getImportItemSource, async (c) => {
  const tenant = callerTenant(c);
  const { id, itemId } = c.req.valid('param');
  await guardImport(c, id, 'creator-or-admin');
  const item = await c.get('deps').imports.getItem(tenant, id, itemId);
  if (item === undefined || item.status !== 'failed' || !keepsOriginal(item.kind)) return fail('not_found');
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
  // The pages it created go to the trash and its zip is deleted by the cleanup job. The cancel is done whatever the queue says: a job that stops on the cancel hands over the same cleanup.
  await deps.enqueueImportCleanup({ importId: id, tenantId: tenant }).catch(() => { deps.log.error('files.unavailable', { operation: 'import-cleanup-enqueue' }); });
  noStore(c);
  return c.json(await stateOf(c, cancelled), 200);
});

/** The upload of file `index` of an import that is not started, when it goes up in parts and is open: the part, its upload id and how the file was cut. The cut is worked out again from the size and the server's sizes, so it holds as long as those do. */
async function openUpload(c: Ctx, record: ImportRecord, index: number) {
  if (record.status !== 'created') return fail('already_started');
  const deps = c.get('deps');
  const part = (await deps.imports.parts(callerTenant(c), record.id)).find((p) => p.ordinal === index);
  const uploadId = part?.uploadId;
  if (part === undefined || uploadId === null || uploadId === undefined) return fail('not_found');
  return { part, uploadId, plan: cutParts(part.bytes, sizingOf(deps.config.import).partBytes) };
}

router.openapi(createImportPartUrls, async (c) => {
  const { id, index } = c.req.valid('param');
  const { partNumbers } = c.req.valid('json');
  const record = await guardImport(c, id, 'creator');
  const { part, uploadId, plan } = await openUpload(c, record, Number(index));
  if (new Set(partNumbers).size !== partNumbers.length || partNumbers.some((n) => n > plan.partCount)) return fail('invalid');
  const files = store(c, 'import-part-urls');
  // Each address signs the exact length of its part (the last is what is left), so that what a page can write is the size it declared.
  const urls = await viaStore(c, 'import-part-urls', () =>
    Promise.all(partNumbers.map(async (partNumber) => ({ partNumber, ...(await files.signPart(part.s3Key, { uploadId, partNumber, size: partLength(part.bytes, plan.partSize, partNumber), ttlSeconds: PART_TTL_SECONDS })) }))),
  );
  noStore(c);
  return c.json({ urls: urls.map((u) => ({ ...u, expiresAt: new Date(u.expiresAt).toISOString() })) }, 200);
});

router.openapi(listImportParts, async (c) => {
  const { id, index } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator');
  const { part, uploadId, plan } = await openUpload(c, record, Number(index));
  const files = store(c, 'import-parts');
  const held = await ifThere(c, 'import-parts', () => files.listParts(part.s3Key, uploadId));
  if (held === undefined) return fail('upload_missing');
  noStore(c);
  return c.json({ partSize: plan.partSize, partCount: plan.partCount, parts: held.map(({ partNumber, size }) => ({ partNumber, size })) }, 200);
});

router.openapi(abortImport, async (c) => {
  const tenant = callerTenant(c);
  const { id } = c.req.valid('param');
  const record = await guardImport(c, id, 'creator');
  const deps = c.get('deps');
  // Only an upload that was not started: an accepted import is the cancel's. The write itself takes only `created` (a start that wins between the read and the write makes it `uploaded`, and then nothing changes), and the row ends as the daily clean-up ends a stale one (`abandoned`); the same cleanup deletes the zips and ends the multipart uploads.
  const now = deps.clock.now();
  if (record.status !== 'created' || !(await deps.imports.abort(tenant, id, now))) return fail('already_started');
  deps.log.info('import.aborted', { importId: id });
  await deps.enqueueImportCleanup({ importId: id, tenantId: tenant }).catch(() => { deps.log.error('files.unavailable', { operation: 'import-cleanup-enqueue' }); });
  noStore(c);
  return c.json(await stateOf(c, { ...record, status: 'failed', error: 'abandoned', finishedAt: now }), 200);
});

export default router;
