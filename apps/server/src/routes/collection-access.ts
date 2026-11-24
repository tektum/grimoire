import { z } from '@hono/zod-openapi';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller, guardCollection } from '../http/collection-guard.js';

const Permission = z.enum(['read', 'read_write']);
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const EntryParams = IdParam.extend({ entryId: z.string().uuid().openapi({ param: { name: 'entryId', in: 'path' } }) });

export const AccessEntrySchema = z
  .object({
    id: z.string().uuid(),
    principalType: z.enum(['user', 'group']),
    principalId: z.string().uuid(),
    name: z.string().describe('Name of the user or the group'),
    permission: Permission,
  })
  .openapi('CollectionAccessEntry');

const AccessListSchema = z
  .object({ defaultPermission: Permission.nullable(), entries: z.array(AccessEntrySchema) })
  .openapi('CollectionAccess');

const GrantBody = z
  .object({ principalType: z.enum(['user', 'group']), principalId: z.string().uuid(), permission: Permission })
  .strict()
  .openapi('GrantCollectionAccess');

const policy = { kind: 'collection', param: 'id', need: 'admin' } as const;
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });

export const listCollectionAccess = defineRoute({
  method: 'get', path: '/v1/collections/{id}/access', operationId: 'listCollectionAccess', summary: 'Who has access to a collection (administrators)', tags: ['collections'],
  policy, request: { params: IdParam }, responses: { 200: json(AccessListSchema, 'The default permission and the entries') },
});

export const putCollectionAccess = defineRoute({
  method: 'put', path: '/v1/collections/{id}/access', operationId: 'putCollectionAccess', summary: 'Give a user or a group access, or change it (administrators)', tags: ['collections'],
  policy, request: { params: IdParam, body: { required: true, content: { 'application/json': { schema: GrantBody } } } },
  responses: { 200: json(AccessEntrySchema, 'The entry; the same entry id for the same principal') },
});

export const deleteCollectionAccess = defineRoute({
  method: 'delete', path: '/v1/collections/{id}/access/{entryId}', operationId: 'deleteCollectionAccess', summary: 'Take an entry away (administrators)', tags: ['collections'],
  policy, request: { params: EntryParams }, responses: { 204: { description: 'The entry is gone' } },
});

const router = createRouter();

router.openapi(listCollectionAccess, async (c) => {
  const { id } = c.req.valid('param');
  await guardCollection(c, id, 'admin');
  const list = await c.get('deps').collections.listAccess(caller(c).tenantId, id);
  return list === undefined ? fail('not_found') : c.json(list, 200);
});

router.openapi(putCollectionAccess, async (c) => {
  const { id } = c.req.valid('param');
  await guardCollection(c, id, 'admin');
  const result = await c.get('deps').collections.upsertAccess(caller(c).tenantId, id, c.req.valid('json'), caller(c).id);
  if (result.kind === 'not-found') return fail('not_found');
  if (result.kind === 'no-principal') return fail('invalid');
  return c.json(result.entry, 200);
});

router.openapi(deleteCollectionAccess, async (c) => {
  const { id, entryId } = c.req.valid('param');
  await guardCollection(c, id, 'admin');
  return (await c.get('deps').collections.removeAccess(caller(c).tenantId, id, entryId, caller(c).id)) ? c.body(null, 204) : fail('not_found');
});

export default router;
