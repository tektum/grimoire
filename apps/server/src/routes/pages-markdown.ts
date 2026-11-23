import { z } from '@hono/zod-openapi';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { guardPage } from '../http/page-guard.js';

const IdParam = z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) });

export const getPageMarkdown = defineRoute({
  method: 'get', path: '/v1/pages/{id}/markdown', operationId: 'getPageMarkdown', summary: 'The last saved Markdown of a page, as a download', tags: ['pages'],
  policy: { kind: 'page', param: 'id', need: 'read' },
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The Markdown the system last saved (empty for a page with none). It is stored text: nothing is converted for this call.',
      headers: z.object({
        'x-saved-at': z.string().describe('When the page was last written, as epoch milliseconds: the number `savedAt` of the page carries'),
        'x-grimoire-markdown-stale': z.literal('true').optional().describe('Present when the editor state is newer than this Markdown'),
        'x-grimoire-markdown-stale-since': z.string().optional().describe('With the stale header: since when, as epoch milliseconds: the number `markdownStaleSince` of the page carries'),
      }),
      content: { 'text/markdown': { schema: z.string() } },
    },
  },
});

/** The text with every lone surrogate replaced by U+FFFD, so `encodeURIComponent` can take it. */
const wellFormed = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');

/** A file name for the download: the page title with anything but plain characters replaced, so no title can end the header or add one. */
function fileName(title: string): string {
  const plain = title.replace(/[^A-Za-z0-9 ._-]/g, '_').trim().slice(0, 80);
  return `${plain === '' ? 'page' : plain}.md`;
}

/** The `filename*` form, which carries the real title in UTF-8 (every character outside the token set percent-encoded). */
function encodedFileName(title: string): string {
  // By code point (a cut through an emoji leaves a lone surrogate, which `encodeURIComponent` refuses), after any lone surrogate is replaced.
  const base = (Array.from(wellFormed(title).trim()).slice(0, 80).join('') || 'page').replace(/[\u0000-\u001f\u007f]/g, '');
  return `${encodeURIComponent(base).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}.md`;
}

const router = createRouter();

router.openapi(getPageMarkdown, async (c) => {
  const { id } = c.req.valid('param');
  await guardPage(c, id, 'read');
  // One row, one statement: the body and the times that say how current it is belong together.
  const page = await c.get('deps').pages.markdownOf(id);
  // Deleted between the access check and the read: the same answer as a page that was never there.
  if (page === undefined) return fail('not_found');
  const headers: Record<string, string> = {
    'content-type': 'text/markdown; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${fileName(page.title)}"; filename*=UTF-8''${encodedFileName(page.title)}`,
    'x-saved-at': String(page.savedAt),
  };
  // Stale: the state was saved and its Markdown could not be made (a recorded time), or the page has a state and no Markdown at all.
  const staleSince = page.markdownStaleSince ?? (page.markdown === null && page.hasState ? page.savedAt : null);
  if (staleSince !== null) {
    headers['x-grimoire-markdown-stale'] = 'true';
    headers['x-grimoire-markdown-stale-since'] = String(staleSince);
  }
  return c.body(page.markdown ?? '', 200, headers);
});

export default router;
