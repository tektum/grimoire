import { z } from '@hono/zod-openapi';
import { fail } from '../http/error.js';
import type { ReplayRebuild } from '../http/idempotency.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller } from '../http/collection-guard.js';
import { AdminUserSchema, requireAdmin } from './users.js';

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const MemberParams = IdParam.extend({ userId: z.string().uuid().openapi({ param: { name: 'userId', in: 'path' } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const taken = json(z.object({ error: z.object({ code: z.string(), message: z.string() }) }), 'A group of that name exists (any case)');

const GroupSchema = z.object({ id: z.string().uuid(), name: z.string(), memberCount: z.number().int() }).openapi('Group');
const GroupListSchema = z.object({ items: z.array(GroupSchema) }).openapi('GroupList');
const MembersSchema = z.object({ items: z.array(AdminUserSchema) }).openapi('GroupMembers');
const NameBody = z.object({ name: z.string().trim().min(1).max(100) }).strict().openapi('GroupName');
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { 'application/json': { schema } } }) as const;
const policy = { kind: 'admin' } as const;

export const listGroups = defineRoute({
  method: 'get', path: '/v1/groups', operationId: 'listGroups', summary: 'List groups (administrators)', tags: ['groups'],
  policy, request: {}, responses: { 200: json(GroupListSchema, 'Every group in name order') },
});

export const createGroup = defineRoute({
  method: 'post', path: '/v1/groups', operationId: 'createGroup', summary: 'Create a group (administrators)', tags: ['groups'],
  policy, idempotent: true, request: { body: body(NameBody) }, responses: { 201: json(GroupSchema, 'The group'), 409: taken },
});

export const patchGroup = defineRoute({
  method: 'patch', path: '/v1/groups/{id}', operationId: 'patchGroup', summary: 'Rename a group (administrators)', tags: ['groups'],
  policy, request: { params: IdParam, body: body(NameBody) }, responses: { 200: json(GroupSchema, 'The group'), 409: taken },
});

export const deleteGroup = defineRoute({
  method: 'delete', path: '/v1/groups/{id}', operationId: 'deleteGroup', summary: 'Delete a group with its members and collection access (administrators)', tags: ['groups'],
  policy, request: { params: IdParam }, responses: { 204: { description: 'The group is gone' } },
});

export const listGroupMembers = defineRoute({
  method: 'get', path: '/v1/groups/{id}/members', operationId: 'listGroupMembers', summary: 'Members of a group (administrators)', tags: ['groups'],
  policy, request: { params: IdParam }, responses: { 200: json(MembersSchema, 'Members in email order') },
});

export const addGroupMember = defineRoute({
  method: 'put', path: '/v1/groups/{id}/members/{userId}', operationId: 'addGroupMember', summary: 'Add a user to a group; adding a member again changes nothing (administrators)', tags: ['groups'],
  policy, request: { params: MemberParams }, responses: { 204: { description: 'The user is a member' } },
});

export const removeGroupMember = defineRoute({
  method: 'delete', path: '/v1/groups/{id}/members/{userId}', operationId: 'removeGroupMember', summary: 'Remove a user from a group (administrators)', tags: ['groups'],
  policy, request: { params: MemberParams }, responses: { 204: { description: 'The user is not a member' } },
});

/** A retry of a create replays the stored group only while the caller is still an administrator and the group is still there. */
export const replayCreateGroup: ReplayRebuild = async (stored, c) => {
  requireAdmin(c);
  const groups = await c.get('deps').admin.listGroups();
  if (!groups.some((g) => g.id === (stored.body as { id: string }).id)) return fail('not_found');
  return Response.json(stored.body, { status: stored.status });
};

const router = createRouter();

router.openapi(listGroups, async (c) => {
  requireAdmin(c);
  return c.json({ items: [...(await c.get('deps').admin.listGroups())] }, 200);
});

router.openapi(createGroup, async (c) => {
  requireAdmin(c);
  const result = await c.get('deps').admin.createGroup(c.req.valid('json').name, caller(c).id);
  return result.kind === 'saved' ? c.json(result.group, 201) : fail('name_taken');
});

router.openapi(patchGroup, async (c) => {
  requireAdmin(c);
  const result = await c.get('deps').admin.renameGroup(c.req.valid('param').id, c.req.valid('json').name, caller(c).id);
  if (result.kind === 'not-found') return fail('not_found');
  return result.kind === 'saved' ? c.json(result.group, 200) : fail('name_taken');
});

router.openapi(deleteGroup, async (c) => {
  requireAdmin(c);
  return (await c.get('deps').admin.deleteGroup(c.req.valid('param').id, caller(c).id)) ? c.body(null, 204) : fail('not_found');
});

router.openapi(listGroupMembers, async (c) => {
  requireAdmin(c);
  const members = await c.get('deps').admin.listMembers(c.req.valid('param').id);
  return members === undefined ? fail('not_found') : c.json({ items: [...members] }, 200);
});

router.openapi(addGroupMember, async (c) => {
  requireAdmin(c);
  const { id, userId } = c.req.valid('param');
  const result = await c.get('deps').admin.addMember(id, userId, caller(c).id);
  return result === 'no-group' || result === 'no-user' ? fail('not_found') : c.body(null, 204);
});

router.openapi(removeGroupMember, async (c) => {
  requireAdmin(c);
  const { id, userId } = c.req.valid('param');
  return (await c.get('deps').admin.removeMember(id, userId, caller(c).id)) ? c.body(null, 204) : fail('not_found');
});

export default router;
