import { z } from '@hono/zod-openapi';
import { callerTenant } from '../http/collection-guard.js';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';
import { guardPage } from '../http/page-guard.js';

const AuthorFields = z.object({ id: z.string().uuid(), name: z.string() });
/** One component for a person; `lastAuthor` repeats the fields inline so that only it is nullable. */
const Author = AuthorFields.openapi('RevisionAuthor');

export const RevisionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.number().describe('Epoch milliseconds: the time of the last edit the revision records'),
    title: z.string(),
    lastAuthor: AuthorFields.nullable().describe('The last person who changed the page; null when that user is gone'),
    authors: z.array(Author).describe('Everyone who changed the page since the previous revision'),
    reason: z.enum(['idle', 'last_editor_left', 'before_restore', 'manual', 'import']),
  })
  .openapi('Revision');

export const RevisionWithMarkdownSchema = RevisionSchema.extend({ markdown: z.string() }).openapi('RevisionWithMarkdown');

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const RevisionParams = IdParam.extend({ rid: z.string().uuid().openapi({ param: { name: 'rid', in: 'path' } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });

export const listRevisions = defineRoute({
  method: 'get', path: '/v1/pages/{id}/revisions', operationId: 'listRevisions', summary: 'The revisions of a page, newest first', tags: ['revisions'],
  policy: { kind: 'page', param: 'id', need: 'read' }, request: { params: IdParam, query: paginationQuery },
  responses: { 200: json(z.object({ items: z.array(RevisionSchema), nextCursor: z.string().nullable() }), 'One page of revisions') },
});

export const getRevision = defineRoute({
  method: 'get', path: '/v1/pages/{id}/revisions/{rid}', operationId: 'getRevision', summary: 'One revision with its Markdown', tags: ['revisions'],
  policy: { kind: 'page', param: 'id', need: 'read' }, request: { params: RevisionParams },
  responses: { 200: json(RevisionWithMarkdownSchema, 'The revision') },
});

export const RestoreSchema = z
  .object({
    title: z.string(),
    markdown: z.string(),
    safetyRevisionId: z.string().uuid().nullable().describe('The revision that holds the page as it was saved before the restore; null when the page had no saved Markdown'),
  })
  .openapi('RestoreRevision');

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const restoreRevision = defineRoute({
  method: 'post', path: '/v1/pages/{id}/revisions/{rid}/restore', operationId: 'restoreRevision', summary: 'Take a revision back: the safety copy is written, the old text is returned', tags: ['revisions'],
  policy: { kind: 'page', param: 'id', need: 'write' }, request: { params: RevisionParams },
  responses: { 200: json(RestoreSchema, 'The revision\'s title and Markdown, and the safety revision'), 409: json(ErrorBody, 'The page is still being saved (markdown_stale), or the safety copy could not be written (save_failed)') },
});

const STALE_MESSAGE = 'The page is still being saved. Try again in a moment.';

const router = createRouter();

router.openapi(listRevisions, async (c) => {
  const { id } = c.req.valid('param');
  const { limit, cursor } = c.req.valid('query');
  await guardPage(c, id, 'read');
  const keys = decodeCursor('revisions', cursor, 2);
  // A hand-made key must not reach the database: a time is a non-negative whole number of microseconds, an id is a UUID.
  if (keys !== undefined && (!Number.isSafeInteger(keys[0]) || (keys[0] as number) < 0 || !z.string().uuid().safeParse(keys[1]).success)) return fail('invalid');
  const rows = await c.get('deps').revisions.list(callerTenant(c), id, { limit: limit + 1, ...(keys === undefined ? {} : { after: [keys[0] as number, keys[1] as string] as const }) });
  const page = toPage('revisions', rows, limit, (r) => [r.sortKey, r.id]);
  // The sort position is for the cursor only: the answer carries the summary.
  return c.json({ items: page.items.map((r) => ({ id: r.id, createdAt: r.createdAt, title: r.title, lastAuthor: r.lastAuthor, authors: r.authors, reason: r.reason })), nextCursor: page.nextCursor }, 200);
});

router.openapi(getRevision, async (c) => {
  const { id, rid } = c.req.valid('param');
  await guardPage(c, id, 'read');
  const revision = await c.get('deps').revisions.get(callerTenant(c), id, rid);
  return revision === undefined ? fail('not_found') : c.json(revision, 200);
});

router.openapi(restoreRevision, async (c) => {
  const { id, rid } = c.req.valid('param');
  await guardPage(c, id, 'write');
  const { revisions } = c.get('deps');
  const tenantId = callerTenant(c);
  const revision = await revisions.get(tenantId, id, rid);
  if (revision === undefined) return fail('not_found');
  // The safety copy first (R9.6); the live document is never touched here: the client applies the returned Markdown as ordinary edits.
  const copy = await revisions.snapshotBeforeRestore(tenantId, id).catch(() => fail('save_failed'));
  if (copy.kind === 'stale') return fail('markdown_stale', STALE_MESSAGE);
  if (copy.kind === 'no-page') return fail('not_found');
  return c.json({ title: revision.title, markdown: revision.markdown, safetyRevisionId: copy.kind === 'nothing-saved' ? null : copy.id }, 200);
});

export default router;
