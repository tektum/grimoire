import { z } from '@hono/zod-openapi';
import type { CollectionRecord } from '@tektum/grimoire-core/ports/collection-repo';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller, guardCollection } from '../http/collection-guard.js';
import type { Level } from '../http/collection-guard.js';

/** Limits of the text fields (R6.13). `name` is 1 to 100 characters. */
const NAME_MAX = 100;
const TEXT_MAX = 2000;
const SHORT_MAX = 64;

const Permission = z.enum(['read', 'read_write']);
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

export const CollectionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    position: z.string().describe('Sort key among collections; compare as bytes'),
    defaultPermission: Permission.nullable().describe('What every member gets without an entry; null for nothing'),
    myPermission: z.enum(['read-write', 'read-only']).describe('What the caller may do here'),
  })
  .openapi('Collection');

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    description: z.string().max(TEXT_MAX).optional(),
    icon: z.string().max(SHORT_MAX).optional(),
    color: z.string().max(SHORT_MAX).optional(),
    defaultPermission: Permission.optional(),
  })
  .strict()
  .openapi('CreateCollection');

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    description: z.string().max(TEXT_MAX).nullable(),
    icon: z.string().max(SHORT_MAX).nullable(),
    color: z.string().max(SHORT_MAX).nullable(),
    defaultPermission: Permission.nullable(),
    position: z.string().min(1).max(255),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0)
  .openapi('PatchCollection');

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });

export const listCollections = defineRoute({
  method: 'get', path: '/v1/collections', operationId: 'listCollections', summary: 'The collections the caller can read, in order', tags: ['collections'],
  policy: { kind: 'authenticated' },
  responses: { 200: json(z.object({ items: z.array(CollectionSchema) }), 'The collections') },
});

export const createCollection = defineRoute({
  method: 'post', path: '/v1/collections', operationId: 'createCollection', summary: 'Create a collection (administrators)', tags: ['collections'],
  policy: { kind: 'admin' }, idempotent: true,
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: { 201: json(CollectionSchema, 'The new collection, last in order') },
});

export const getCollection = defineRoute({
  method: 'get', path: '/v1/collections/{id}', operationId: 'getCollection', summary: 'One collection', tags: ['collections'],
  policy: { kind: 'collection', param: 'id', need: 'read' }, request: { params: IdParam },
  responses: { 200: json(CollectionSchema, 'The collection') },
});

export const patchCollection = defineRoute({
  method: 'patch', path: '/v1/collections/{id}', operationId: 'patchCollection', summary: 'Change a collection (administrators)', tags: ['collections'],
  policy: { kind: 'collection', param: 'id', need: 'admin' },
  request: { params: IdParam, body: { required: true, content: { 'application/json': { schema: PatchBody } } } },
  responses: { 200: json(CollectionSchema, 'The collection after the change'), 409: json(z.object({ error: z.object({ code: z.string(), message: z.string() }) }), 'The position is already used') },
});

const TreePageSchema = z
  .object({ id: z.string().uuid(), urlId: z.string(), parentId: z.string().uuid().nullable(), position: z.string(), title: z.string(), icon: z.string().nullable() })
  .openapi('CollectionTreePage');

export const deleteCollection = defineRoute({
  method: 'delete', path: '/v1/collections/{id}', operationId: 'deleteCollection', summary: 'Delete a collection and every page in it as one trash batch (administrators)', tags: ['collections'],
  policy: { kind: 'collection', param: 'id', need: 'admin' }, request: { params: IdParam },
  responses: { 204: { description: 'The collection and its pages are in the trash' } },
});

export const getCollectionTree = defineRoute({
  method: 'get', path: '/v1/collections/{id}/tree', operationId: 'getCollectionTree', summary: 'The live pages of a collection, flat', tags: ['collections'],
  policy: { kind: 'collection', param: 'id', need: 'read' }, request: { params: IdParam },
  responses: { 200: json(z.object({ pages: z.array(TreePageSchema) }), 'Id, urlId, parentId, position, title and icon of every live page') },
});

/** The one place a stored collection becomes the API's: `myPermission` is the authoriser's answer, never a stored spelling. */
export function present(row: CollectionRecord, mine: Level): z.infer<typeof CollectionSchema> {
  return { ...row, myPermission: mine };
}

const router = createRouter();

router.openapi(listCollections, async (c) => {
  const { authorizer, collections } = c.get('deps');
  const visible = await authorizer.visibleCollections(caller(c).id);
  const levels = new Map(visible.map((v) => [v.collectionId, v.access] as const));
  const rows = await collections.listLive([...levels.keys()]);
  return c.json({ items: rows.map((row) => present(row, levels.get(row.id) as Level)) }, 200);
});

router.openapi(createCollection, async (c) => {
  const user = caller(c);
  if (user.role !== 'admin') return fail('forbidden');
  const { collections, ordering } = c.get('deps');
  const created = await collections.append({ ...c.req.valid('json'), createdBy: user.id }, (last) => ordering.between(last, null));
  return c.json(present(created, 'read-write'), 201);
});

router.openapi(getCollection, async (c) => {
  const { id } = c.req.valid('param');
  const mine = await guardCollection(c, id, 'read');
  const row = await c.get('deps').collections.get(id);
  return row === undefined ? fail('not_found') : c.json(present(row, mine), 200);
});

router.openapi(patchCollection, async (c) => {
  const { id } = c.req.valid('param');
  const mine = await guardCollection(c, id, 'admin');
  const { collections, ordering } = c.get('deps');
  const patch = c.req.valid('json');
  if (patch.position !== undefined && !ordering.isValidPosition(patch.position)) return fail('invalid');
  const result = await collections.update(id, patch, caller(c).id);
  if (result.kind === 'not-found') return fail('not_found');
  if (result.kind === 'position-taken') return fail('conflict');
  return c.json(present(result.collection, mine), 200);
});

router.openapi(deleteCollection, async (c) => {
  const { id } = c.req.valid('param');
  await guardCollection(c, id, 'admin');
  return (await c.get('deps').collections.softDelete(id, caller(c).id)) === undefined ? fail('not_found') : c.body(null, 204);
});

router.openapi(getCollectionTree, async (c) => {
  const { id } = c.req.valid('param');
  await guardCollection(c, id, 'read');
  const pages = await c.get('deps').collections.tree(id);
  return pages === undefined ? fail('not_found') : c.json({ pages: [...pages] }, 200);
});

export default router;
