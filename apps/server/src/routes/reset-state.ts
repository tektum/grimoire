import { z } from '@hono/zod-openapi';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import { caller } from '../http/collection-guard.js';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { guardPage } from '../http/page-guard.js';
import { seedRefusalToHttp } from '../http/seed-errors.js';
import { requireAdmin } from './users.js';

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });
const Body = z
  .object({
    markdown: z.string().optional().describe('Replacement Markdown, converted with the strict limits; without it the saved Markdown is kept'),
    confirmStale: z.boolean().optional().describe('Accept losing the newest edits when the saved Markdown is older than the editor state'),
  })
  .strict()
  .openapi('ResetPageState');
const Reset = z
  .object({ stateEpoch: z.number().int(), markdownStale: z.boolean().describe('The kept Markdown was older than the state that was dropped') })
  .openapi('PageStateReset');

// Not `idempotent`: a retry would reset again and bump the epoch again, which is what the caller asked for; there is no stored answer to replay.
export const resetPageState = defineRoute({
  method: 'post', path: '/v1/pages/{id}/reset-state', operationId: 'resetPageState', summary: 'Drop the editor state of a page and rebuild it from Markdown (administrators)', tags: ['pages'],
  policy: { kind: 'admin' }, rateLimit: { max: 5, windowSeconds: 60 },
  request: { params: IdParam, body: { required: false, content: { 'application/json': { schema: Body } } } },
  responses: { 200: { description: 'The new epoch', content: { 'application/json': { schema: Reset } } }, 409: { description: 'The saved Markdown is older than the state: send `confirmStale`, or supply Markdown', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) } } } },
});

const router = createRouter();

router.openapi(resetPageState, async (c) => {
  const { id } = c.req.valid('param');
  // A page the caller cannot read is 404 whatever their role; a reader who is not an administrator is 403.
  await guardPage(c, id, 'read');
  requireAdmin(c);
  const admin = caller(c);
  const body = c.req.valid('json');
  const { converter, pages, pageState } = c.get('deps');
  const page = await pages.get(id);
  if (page === undefined) return fail('not_found');
  // The conversion runs before the transaction, never under the row lock, and with the admin's id as key.
  let content;
  if (body.markdown !== undefined) {
    const seeded = await seedUserMarkdown(converter, admin.id, page.title, body.markdown);
    if (isSeedRefusal(seeded)) {
      const refused = seedRefusalToHttp(seeded);
      return fail(refused.code, refused.message, refused.headers);
    }
    content = seeded;
  }
  const result = await pageState.reset({ pageId: id, actorId: admin.id, ...(content === undefined ? {} : { content }), confirmStale: body.confirmStale === true });
  switch (result.kind) {
    case 'reset': return c.json({ stateEpoch: result.stateEpoch, markdownStale: result.markdownStale }, 200);
    case 'not-found': return fail('not_found');
    case 'stale-unconfirmed': return fail('markdown_stale');
    case 'empty-state': return fail('invalid');
  }
});

export default router;
