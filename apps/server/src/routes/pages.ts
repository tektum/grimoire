import { z } from '@hono/zod-openapi';
import type { PageMeta } from '@tektum/grimoire-core/ports/page-repo';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { SeedRefusal } from '@tektum/grimoire-core/pages/seeded-content';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller, guardCollection } from '../http/collection-guard.js';

/** Page tree limits (R5.8, R6.22, R6.54). */
export const PAGE_LIMITS = { maxDepth: 32, maxPages: 10_000 } as const;
const TITLE_MAX = 255;

export const PageMetaSchema = z
  .object({
    id: z.string().uuid(),
    urlId: z.string(),
    collectionId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    position: z.string().describe('Sort key among siblings; compare as bytes'),
    title: z.string(),
    icon: z.string().nullable(),
    createdBy: z.string().uuid(),
    lastEditedBy: z.string().uuid().nullable(),
    lastEditedAt: z.number().nullable().describe('Epoch milliseconds'),
    savedAt: z.number().describe('Epoch milliseconds the page was last written'),
    stateEpoch: z.number().int(),
  })
  .openapi('PageMeta');

const CreateBody = z
  .object({
    collectionId: z.string().uuid(),
    parentId: z.string().uuid().nullable().optional(),
    title: z.string().min(1).max(TITLE_MAX).optional(),
    afterId: z.string().uuid().optional(),
    markdown: z.string().optional().describe('Seed Markdown; limited by the server (size, lines, markers per line)'),
  })
  .strict()
  .openapi('CreatePage');

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const createPage = defineRoute({
  method: 'post', path: '/v1/pages', operationId: 'createPage', summary: 'Create a page', tags: ['pages'],
  policy: { kind: 'collection-body', field: 'collectionId', need: 'write' }, idempotent: true,
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: json(PageMetaSchema, 'The new page'),
    409: json(ErrorBody, 'Too deep, the collection is full or deleted'),
  },
});

/** What a refused seed becomes (R3.21): a limit or a bad document is 422 with the converter's sentence; a second conversion of one user is 429; a busy or broken pool is 503. */
function refuse(r: SeedRefusal): never {
  if (r.detail === 'one-at-a-time') return fail('rate_limited', undefined, { 'retry-after': '1' });
  const refused = r.stage === 'seed' ? ['invalid-markdown', 'too-large', 'timeout'] : ['too-large', 'too-deep'];
  return refused.includes(r.reason) ? fail('invalid', r.message) : fail('unavailable', r.message);
}

const router = createRouter();

router.openapi(createPage, async (c) => {
  const user = caller(c);
  const body = c.req.valid('json');
  await guardCollection(c, body.collectionId, 'write');
  const { converter, pages, ordering } = c.get('deps');
  const title = body.title ?? '';
  // The conversion runs before the transaction, never under the collection lock.
  let content;
  if (body.markdown !== undefined) {
    const seeded = await seedUserMarkdown(converter, user.id, title, body.markdown);
    if (isSeedRefusal(seeded)) return refuse(seeded);
    content = seeded;
  }
  const result = await pages.create(
    { collectionId: body.collectionId, parentId: body.parentId ?? null, afterId: body.afterId ?? null, title, createdBy: user.id, content },
    PAGE_LIMITS,
    (before, after) => ordering.between(before, after),
  );
  switch (result.kind) {
    case 'created': return c.json(result.page satisfies PageMeta, 201);
    case 'collection-deleted': return fail('collection_deleted');
    case 'no-parent': return fail('not_found');
    case 'no-after': return fail('invalid');
    case 'too-deep': return fail('too_deep');
    case 'collection-full': return fail('collection_full');
  }
});

export default router;
