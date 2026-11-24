import { z } from '@hono/zod-openapi';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller } from '../http/collection-guard.js';
import { decodeCursor, paginationQuery, toPage } from '../http/pagination.js';

const Role = z.enum(['admin', 'member', 'viewer']);
const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });

export const AdminUserSchema = z
  .object({ id: z.string().uuid(), email: z.string(), name: z.string(), role: Role, suspended: z.boolean() })
  .openapi('AdminUser');
const UserListSchema = z.object({ items: z.array(AdminUserSchema), nextCursor: z.string().nullable() }).openapi('AdminUserList');
const ListQuery = paginationQuery.extend({ q: z.string().trim().min(1).max(200).optional() });
const PatchBody = z
  .object({ role: Role.optional(), suspended: z.boolean().optional() })
  .strict()
  .refine((b) => b.role !== undefined || b.suspended !== undefined)
  .openapi('PatchUser', { minProperties: 1 });
const NamesBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict().openapi('UserNamesRequest');
const NamesSchema = z.object({ items: z.array(z.object({ id: z.string().uuid(), name: z.string() })) }).openapi('UserNames');

export const listUsers = defineRoute({
  method: 'get', path: '/v1/users', operationId: 'listUsers', summary: 'List users (administrators)', tags: ['users'],
  policy: { kind: 'admin' }, request: { query: ListQuery }, responses: { 200: json(UserListSchema, 'A page of users in email order') },
});

export const patchUser = defineRoute({
  method: 'patch', path: '/v1/users/{id}', operationId: 'patchUser', summary: 'Change a role or suspend or unsuspend a user (administrators)', tags: ['users'],
  policy: { kind: 'admin' }, request: { params: IdParam, body: { required: true, content: { 'application/json': { schema: PatchBody } } } },
  responses: { 200: json(AdminUserSchema, 'The user after the change'), 409: json(z.object({ error: z.object({ code: z.string(), message: z.string() }) }), 'The change would leave no active administrator') },
});

export const userNames = defineRoute({
  method: 'post', path: '/v1/users/names', operationId: 'userNames', summary: 'Display names for user ids', tags: ['users'],
  policy: { kind: 'authenticated' }, rateLimit: { max: 60, windowSeconds: 60 },
  request: { body: { required: true, content: { 'application/json': { schema: NamesBody } } } },
  responses: { 200: json(NamesSchema, 'Name per known id; unknown ids are left out') },
});

const router = createRouter();

/** The `admin` policy: the role of the signed-in user, read by the authentication step. */
export const requireAdmin = (c: Parameters<typeof caller>[0]): void => {
  if (caller(c).role !== 'admin') fail('forbidden');
};

router.openapi(listUsers, async (c) => {
  requireAdmin(c);
  const { limit, cursor, q } = c.req.valid('query');
  const keys = decodeCursor('users', cursor, 3);
  // A cursor belongs to the search it came from: another `q` would skip rows, and a hand-made key must not reach the database cast.
  if (keys !== undefined && (typeof keys[0] !== 'string' || !z.string().uuid().safeParse(keys[1]).success || keys[2] !== (q ?? ''))) return fail('invalid');
  const rows = await c.get('deps').admin.listUsers(caller(c).tenantId, { limit: limit + 1, ...(q === undefined ? {} : { q }), ...(keys === undefined ? {} : { after: [keys[0] as string, keys[1] as string] as const }) });
  return c.json(toPage('users', rows, limit, (u) => [u.email, u.id, q ?? '']), 200);
});

router.openapi(patchUser, async (c) => {
  requireAdmin(c);
  const { id } = c.req.valid('param');
  const result = await c.get('deps').admin.patchUser(caller(c).tenantId, id, c.req.valid('json'), caller(c).id);
  if (result.kind === 'not-found') return fail('not_found');
  if (result.kind === 'last-admin') return fail('last_admin');
  return c.json(result.user, 200);
});

router.openapi(userNames, async (c) => {
  const items = await c.get('deps').admin.userNames(caller(c).tenantId, c.req.valid('json').ids);
  return c.json({ items: [...items] }, 200);
});

export default router;
