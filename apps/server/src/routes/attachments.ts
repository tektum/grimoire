import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { signedDownload } from '@tektum/grimoire-core/attachments/downloads';
import { completeUpload, createUpload, findUploadOf, markdownPathOf, resignUpload } from '@tektum/grimoire-core/attachments/uploads';
import type { AttachmentDeps } from '@tektum/grimoire-core/attachments/uploads';
import type { AttachmentRow } from '@tektum/grimoire-core/ports/attachment-repo';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { attachmentDeps } from '../attachments/deps.js';
import type { UploadLimits } from '../attachments/deps.js';
import { caller, callerTenant } from '../http/collection-guard.js';
import { fail } from '../http/error.js';
import type { AppEnv } from '../http/env.js';
import { createRouter, defineRoute } from '../http/factory.js';
import type { ReplayRebuild } from '../http/idempotency.js';
import { guardPage } from '../http/page-guard.js';
import type { ErrorEvents } from '../events.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

const CreateBody = z
  .object({
    pageId: z.string().uuid(),
    fileName: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(255),
    size: z.number().describe('Bytes; a positive whole number not above the largest upload'),
  })
  .strict()
  .openapi('CreateAttachment');
const Upload = z
  .object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.number().int().describe('Epoch milliseconds') })
  .openapi('AttachmentUpload');
const Created = z
  .object({ id: z.string().uuid(), upload: Upload, markdownPath: z.string().describe('The path to put in the page as the image or link target') })
  .openapi('AttachmentCreated');
const Ready = z
  .object({ id: z.string().uuid(), pageId: z.string().uuid(), fileName: z.string(), contentType: z.string(), size: z.number().int(), markdownPath: z.string() })
  .openapi('Attachment');
const Link = z.object({ url: z.string(), expiresAt: z.number().int().describe('Epoch milliseconds') }).openapi('AttachmentLink');
const DownloadQuery = z.object({ download: z.enum(['true', 'false']).optional().describe('`true` asks for a download instead of showing an image inline') });
const UrlsBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(50), download: z.boolean().optional() }).strict().openapi('AttachmentUrlsRequest');
const Urls = z.object({ urls: z.array(Link.extend({ id: z.string().uuid() })).describe('One entry for each id the caller can read; the others are left out') }).openapi('AttachmentUrls');

export const createAttachment = defineRoute({
  method: 'post', path: '/v1/attachments', operationId: 'createAttachment', summary: 'Start an upload: a pending attachment and a signed upload URL', tags: ['attachments'],
  policy: { kind: 'page-body', field: 'pageId', need: 'write' }, rateLimit: { max: 25, windowSeconds: 60 }, idempotent: true,
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: json(Created, 'The attachment and where to PUT the bytes (the URL works for 10 minutes)'),
    413: json(ErrorBody, 'Larger than the largest upload'),
    422: json(ErrorBody, 'A type that is not allowed, or a size that is not a positive whole number'),
    429: json(ErrorBody, 'Too many uploads waiting to be completed'),
    503: json(ErrorBody, 'The file store is not configured or does not answer'),
  },
});

export const completeAttachment = defineRoute({
  method: 'post', path: '/v1/attachments/{id}/complete', operationId: 'completeAttachment', summary: 'Finish an upload after the bytes were sent', tags: ['attachments'],
  policy: { kind: 'uploader', param: 'id' },
  request: { params: IdParam },
  responses: {
    200: json(Ready, 'The attachment is ready (also when it already was)'),
    404: json(ErrorBody, 'Not found, expired, not yours, or the page is no longer yours to write'),
    409: json(ErrorBody, '`upload_missing` or `size_mismatch`: the upload is discarded'),
    422: json(ErrorBody, '`type_mismatch`: the bytes are not the declared type; the upload is discarded'),
    503: json(ErrorBody, 'The file store is not configured or does not answer'),
  },
});

export const getAttachmentLink = defineRoute({
  method: 'get', path: '/v1/attachments/{id}', operationId: 'getAttachmentLink', summary: 'A short-lived download link for a ready attachment', tags: ['attachments'],
  policy: { kind: 'attachment', param: 'id', need: 'read' },
  request: { params: IdParam, query: DownloadQuery },
  responses: { 200: json(Link, 'The link, valid for 5 minutes'), 404: json(ErrorBody, 'Not found, not ready, or the page is not readable'), 503: json(ErrorBody, 'The file store is not configured or does not answer') },
});

export const getAttachmentLinks = defineRoute({
  method: 'post', path: '/v1/attachments/urls', operationId: 'getAttachmentLinks', summary: 'Download links for up to 50 attachments at once', tags: ['attachments'],
  policy: { kind: 'authenticated' },
  request: { body: { required: true, content: { 'application/json': { schema: UrlsBody } } } },
  responses: { 200: json(Urls, 'A link for each attachment the caller can read'), 422: json(ErrorBody, 'No id, or more than 50'), 503: json(ErrorBody, 'The file store is not configured') },
});

type Ctx = Context<AppEnv>;

/** The file routes need a store; without one they answer 503 and the rest of the server keeps working. */
function usable(c: Ctx, operation: ErrorEvents['files.unavailable']['operation']): { readonly deps: AttachmentDeps; readonly limits: UploadLimits } {
  const d = attachmentDeps(c.get('deps'));
  if (d === undefined) {
    c.get('deps').log.error('files.unavailable', { operation });
    return fail('unavailable');
  }
  return d;
}

/** A store that does not answer is 503, logged without the store's own message. */
async function viaStore<T>(c: Ctx, operation: ErrorEvents['files.unavailable']['operation'], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof FileStorageError)) throw error;
    c.get('deps').log.error('files.unavailable', { operation });
    return fail('unavailable');
  }
}

const noStore = (c: Ctx): void => {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
};

const presentReady = (row: AttachmentRow) => ({ id: row.id, pageId: row.pageId, fileName: row.fileName, contentType: row.contentType, size: row.size, markdownPath: markdownPathOf(row) });

/** The id in the path of `POST /v1/attachments/{id}/...` or the body of the stored create answer. */
const storedId = (stored: { body: unknown }): string => (stored.body as { id: string }).id;

/** The stored answer of a create has no signed URL (it is never stored); `upload` is made new on every replay. */
export const storedCreateAttachment = (body: unknown): unknown => {
  const { id, markdownPath } = body as { id: string; markdownPath: string };
  return { id, markdownPath };
};

/**
 * A retry of a create with the same Idempotency-Key signs a fresh upload while the row is pending and the caller can still write the page; after that (completed,
 * expired, cleaned up, or access lost) it is 409 `conflict`, never the old URL.
 */
export const replayCreateAttachment: ReplayRebuild = async (stored, c) => {
  const { deps: d } = usable(c, 'create');
  const id = storedId(stored);
  const row = await d.repo.get(id);
  if (row === undefined || row.tenantId !== callerTenant(c)) return fail('conflict');
  await guardPage(c, row.pageId, 'write');
  const again = await viaStore(c, 'create', () => resignUpload(d, id, caller(c).id, callerTenant(c)));
  if (again.kind === 'gone') return fail('conflict');
  return Response.json({ id, upload: again.upload, markdownPath: again.markdownPath }, { status: stored.status, headers: { 'cache-control': 'no-store' } });
};

const router = createRouter();

router.openapi(createAttachment, async (c) => {
  const user = caller(c);
  const body = c.req.valid('json');
  await guardPage(c, body.pageId, 'write');
  const { deps: d, limits } = usable(c, 'create');
  const result = await viaStore(c, 'create', () => createUpload(d, { ...body, uploaderId: user.id, tenantId: callerTenant(c) }, limits));
  if (result.kind === 'refused') return fail(result.reason === 'no-page' || result.reason === 'no-user' ? 'not_found' : result.reason);
  c.get('deps').log.info('attachments.upload_created', { attachmentId: result.id, size: body.size });
  noStore(c);
  return c.json({ id: result.id, upload: result.upload, markdownPath: result.markdownPath }, 201);
});

/** Writing to the page is checked again at completion: anything but read-write is 404, so the row of a page that was trashed, or lost, stays untouched. */
async function mayWrite(c: Ctx, row: AttachmentRow): Promise<boolean> {
  const access = await c.get('deps').access.pageAccess({ userId: caller(c).id, pageId: row.pageId });
  return access.result === 'allowed' && access.access === 'read-write';
}

router.openapi(completeAttachment, async (c) => {
  const user = caller(c);
  const { id } = c.req.valid('param');
  const { deps: d } = usable(c, 'complete');
  const row = await findUploadOf(d, id, user.id, callerTenant(c));
  if (row === undefined || !(await mayWrite(c, row))) return fail('not_found');
  const result = await viaStore(c, 'complete', () => completeUpload(d, row));
  if (result.kind === 'gone') return fail('not_found');
  if (result.kind === 'refused') {
    c.get('deps').log.warn('attachments.refused', { attachmentId: id, reason: result.reason });
    return fail(result.reason);
  }
  if (row.status === 'pending') c.get('deps').log.info('attachments.completed', { attachmentId: id });
  noStore(c);
  return c.json(presentReady(result.row), 200);
});

router.openapi(getAttachmentLink, async (c) => {
  const { id } = c.req.valid('param');
  const download = c.req.valid('query').download === 'true';
  const { deps: d } = usable(c, 'download');
  const row = await d.repo.get(id);
  if (row === undefined || row.status !== 'ready' || row.tenantId !== callerTenant(c)) return fail('not_found');
  await guardPage(c, row.pageId, 'read');
  const link = await viaStore(c, 'download', async () => {
    try {
      await d.files.head(row.key);
    } catch (error) {
      if (error instanceof FileStorageError && error.kind === 'not-found') return undefined;
      throw error;
    }
    return signedDownload(d.files, row, download, callerTenant(c));
  });
  if (link === undefined) return fail('not_found');
  noStore(c);
  return c.json(link, 200);
});

router.openapi(getAttachmentLinks, async (c) => {
  const user = caller(c);
  const { ids, download } = c.req.valid('json');
  const { deps: d } = usable(c, 'urls');
  const rows = (await d.repo.getMany([...new Set(ids)])).filter((r) => r.status === 'ready' && r.tenantId === callerTenant(c));
  const access = await c.get('deps').access.pageAccessMany(rows.map((r) => ({ userId: user.id, pageId: r.pageId })));
  const readable = rows.filter((_, i) => access[i]?.result === 'allowed');
  const urls = await viaStore(c, 'urls', () => Promise.all(readable.map(async (r) => ({ id: r.id, ...(await signedDownload(d.files, r, download === true, callerTenant(c))) }))));
  noStore(c);
  return c.json({ urls }, 200);
});

export default router;
