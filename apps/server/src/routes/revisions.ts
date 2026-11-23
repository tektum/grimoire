import { z } from '@hono/zod-openapi';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';
import { guardPage } from '../http/page-guard.js';

const Author = z.object({ id: z.string().uuid(), name: z.string() }).openapi('RevisionAuthor');

export const RevisionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.number().describe('Epoch milliseconds: the time of the last edit the revision records'),
    title: z.string(),
    lastAuthor: Author.nullable().describe('The last person who changed the page; null when that user is gone'),
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

const router = createRouter();

router.openapi(listRevisions, async (c) => {
  const { id } = c.req.valid('param');
  const { limit, cursor } = c.req.valid('query');
  await guardPage(c, id, 'read');
  const keys = decodeCursor('revisions', cursor, 2);
  // A hand-made key must not reach the database cast.
  if (keys !== undefined && (!Number.isSafeInteger(keys[0]) || !z.string().uuid().safeParse(keys[1]).success)) return fail('invalid');
  const rows = await c.get('deps').revisions.list(id, { limit: limit + 1, ...(keys === undefined ? {} : { after: [keys[0] as number, keys[1] as string] as const }) });
  return c.json(toPage('revisions', rows, limit, (r) => [r.createdAt, r.id]) as { items: typeof rows[number][]; nextCursor: string | null }, 200);
});

router.openapi(getRevision, async (c) => {
  const { id, rid } = c.req.valid('param');
  await guardPage(c, id, 'read');
  const revision = await c.get('deps').revisions.get(id, rid);
  return revision === undefined ? fail('not_found') : c.json(revision, 200);
});

export default router;
