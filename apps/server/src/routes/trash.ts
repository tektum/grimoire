import { z } from '@hono/zod-openapi';
import { purgeBatch } from '@tektum/grimoire-core/pages/purge';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller, callerTenant } from '../http/collection-guard.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';
import { addLimits, ErrorBody, PageMetaSchema } from './pages.js';

// This file is the one place that asks the access checks to see deleted pages and collections (`includeDeleted`), and it asks only after the
// role or the write right the route needs: the list for what the caller can write (an administrator: everything), the restore for a caller
// who can write the page's collection, the purge for an administrator. Nothing else in the server may pass it.

/** Deleted batches are kept this long before the daily job removes them (R9.20). */
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});
const TrashQuery = paginationQuery.extend({ collectionId: z.string().uuid().optional() });
const TrashItem = z
  .object({
    id: z.string().uuid().describe('The root page of the deleted batch; the trash routes take this id'),
    title: z.string(),
    collectionId: z.string().uuid(),
    deletedAt: z.number().describe('Epoch milliseconds'),
    deletedBy: z.string().uuid().nullable(),
    daysLeft: z.number().int().describe('Whole days until the batch is removed for good'),
  })
  .openapi('TrashItem');
const TrashList = z.object({ items: z.array(TrashItem), nextCursor: z.string().nullable() }).openapi('TrashList');

export const listTrash = defineRoute({
  method: 'get',
  path: '/v1/trash',
  operationId: 'listTrash',
  summary: 'The deleted batches the caller can write, newest first',
  tags: ['trash'],
  policy: { kind: 'authenticated' },
  request: { query: TrashQuery },
  responses: { 200: { description: 'The roots of the deleted batches', content: { 'application/json': { schema: TrashList } } } },
});

export const restoreFromTrash = defineRoute({
  method: 'post',
  path: '/v1/trash/{id}/restore',
  operationId: 'restoreFromTrash',
  summary: 'Restore a deleted batch',
  tags: ['trash'],
  policy: { kind: 'trash', param: 'id', need: 'write' },
  request: { params: IdParam },
  responses: {
    200: { description: 'The restored root page', content: { 'application/json': { schema: PageMetaSchema } } },
    409: {
      description: 'The collection is deleted (`collection_deleted`) or would be over its page limit (`collection_full`), the workspace would be over its limit of pages (`tenant_pages_full`), or the page moved to another collection meanwhile (`conflict`)',
      content: { 'application/json': { schema: ErrorBody } },
    },
  },
});

export const purgeFromTrash = defineRoute({
  method: 'delete',
  path: '/v1/trash/{id}',
  operationId: 'purgeFromTrash',
  summary: 'Remove a deleted batch for good (administrators)',
  tags: ['trash'],
  policy: { kind: 'admin' },
  request: { params: IdParam },
  responses: { 204: { description: 'The batch and its files are gone' } },
});

const router = createRouter();

router.openapi(listTrash, async (c) => {
  const user = caller(c);
  const { limit, cursor, collectionId } = c.req.valid('query');
  const { authorizer, trash, clock } = c.get('deps');
  let scope: readonly string[] | null;
  if (collectionId !== undefined) {
    // One collection: it must be writable by the caller (an administrator: any), or it is not there for them.
    const decision = await authorizer.checkCollection({ tenantId: callerTenant(c), userId: user.id, collectionId }, { includeDeleted: true });
    if (user.role !== 'admin' && decision.access !== 'read-write') return fail('not_found');
    scope = [collectionId];
  } else if (user.role === 'admin') {
    scope = null;
  } else {
    const visible = await authorizer.visibleCollections(callerTenant(c), user.id, { includeDeleted: true });
    scope = visible.filter((v) => v.access === 'read-write').map((v) => v.collectionId);
  }
  const keys = decodeCursor('trash', cursor, 2);
  // A cursor is checked down to its types: a forged one is 422 here, not a database error.
  if (keys !== undefined && !(Number.isSafeInteger(keys[0]) && z.string().uuid().safeParse(keys[1]).success)) return fail('invalid');
  const after = keys === undefined ? undefined : { deletedAt: Number(keys[0]), id: String(keys[1]) };
  const rows = scope !== null && scope.length === 0 ? [] : await trash.roots(callerTenant(c), scope, limit + 1, after);
  const now = clock.now();
  const page = toPage('trash', rows, limit, (row) => [row.deletedAt, row.id]);
  return c.json(
    {
      items: page.items.map((row) => ({ ...row, daysLeft: Math.max(0, Math.ceil((row.deletedAt + RETENTION_DAYS * DAY_MS - now) / DAY_MS)) })),
      nextCursor: page.nextCursor,
    },
    200,
  );
});

router.openapi(restoreFromTrash, async (c) => {
  const user = caller(c);
  const { id } = c.req.valid('param');
  const { authorizer, trash, ordering } = c.get('deps');
  const root = await trash.rootOf(callerTenant(c), id);
  if (root === undefined) return fail('not_found');
  // Write access on the collection of the page, deleted or not. A reader without write, and anyone who cannot read, get the same 404.
  const decision = await authorizer.checkCollection({ tenantId: callerTenant(c), userId: user.id, collectionId: root.collectionId }, { includeDeleted: true });
  if (decision.access !== 'read-write') return fail('not_found');
  // The restore is bound to the collection that was checked: a page that moved since is not restored on that check.
  const result = await trash.restore(callerTenant(c), id, root.collectionId, addLimits(c), (before, after) => ordering.between(before, after));
  switch (result.kind) {
    case 'restored':
      return c.json(result.page, 200);
    case 'not-found':
      return fail('not_found');
    case 'collection-deleted':
      return fail('collection_deleted');
    case 'collection-full':
      return fail('collection_full');
    case 'tenant-pages-full':
      return fail('tenant_pages_full');
    case 'conflict':
      return fail('conflict');
  }
});

router.openapi(purgeFromTrash, async (c) => {
  const user = caller(c);
  // The role comes before any lookup, so a non-administrator learns nothing about which ids exist.
  if (user.role !== 'admin') return fail('forbidden');
  const { id } = c.req.valid('param');
  const { trash, deleteFiles } = c.get('deps');
  const root = await trash.rootOf(callerTenant(c), id);
  if (root === undefined) return fail('not_found');
  await purgeBatch({ trash, deleteFiles }, callerTenant(c), root.batch, user.id);
  return c.body(null, 204);
});

export default router;
