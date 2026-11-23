import { z } from '@hono/zod-openapi';
import { errorResponse } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';

export const MeSchema = z
  .object({
    id: z.string().describe('The user id'),
    email: z.string().describe('The sign-in email address'),
    name: z.string().describe('The display name'),
    role: z.enum(['admin', 'member', 'viewer']).describe('The role of the user'),
  })
  .openapi('Me');

export const getMe = defineRoute({
  method: 'get',
  path: '/v1/me',
  operationId: 'getMe',
  summary: 'The signed-in user; the first call creates the user',
  tags: ['me'],
  policy: { kind: 'authenticated', provision: true },
  responses: { 200: { description: 'The signed-in user', content: { 'application/json': { schema: MeSchema } } } },
});

const router = createRouter();

router.openapi(getMe, async (c) => {
  const { provisioner } = c.get('deps');
  // A returning user was read and re-checked by the authentication step; nothing is created for them here.
  let user = c.get('user');
  if (user === undefined) {
    const identity = c.get('identity');
    const devRole = c.get('devRole');
    if (identity === undefined) return errorResponse('unauthenticated') as never;
    const result = await provisioner.signIn({ identity, ...(devRole === undefined ? {} : { devRole }) });
    if (result.kind === 'refused') {
      const unavailable = result.reason === 'profile-unavailable' || result.reason === 'profile-missing';
      return errorResponse(unavailable ? 'unavailable' : 'not_allowed') as never;
    }
    if (result.user.suspended) return errorResponse('account_suspended') as never;
    user = result.user;
  }
  return c.json({ id: user.id, email: user.email, name: user.name, role: user.role }, 200);
});

export default router;
