import { z } from '@hono/zod-openapi';
import { SearchTimeoutError } from '@tektum/grimoire-core/ports/search-repo';
import { InvalidSearchCursor, decodeHybridCursor } from '@tektum/grimoire-core/search/cursor';
import { type HybridHit, HybridContinuationUnavailable, hybridSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { fail } from '../http/error.js';
import { createRouter, defineRoute } from '../http/factory.js';
import { caller, callerTenant } from '../http/collection-guard.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CURSOR_CHARS = 1024;

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200).describe('What to look for, 1 to 200 characters after trimming'),
  collectionId: z.string().uuid().optional().describe('Only this collection; one the caller cannot read gives an empty list'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(MAX_CURSOR_CHARS).optional(),
});

const SnippetSchema = z
  .object({
    text: z.string().describe('Plain text: never markup. The client draws it as text'),
    ranges: z.array(z.tuple([z.number().int(), z.number().int()])).describe('[start, end) offsets in UTF-16 code units of the matched words, inside the text and not overlapping'),
  })
  .openapi('SearchSnippet');

const SearchItem = z
  .object({
    pageId: z.string().uuid(),
    urlId: z.string(),
    title: z.string(),
    snippet: SnippetSchema,
    matchedPassage: z
      .object({ text: z.string().max(300).openapi({ maxLength: 300 }).describe('Plain text of the best chunk of the page, cut at a word boundary: never markup. The client draws it as text') })
      .optional()
      .describe('Present when the best chunk of the page came from the meaning of the query (a page found by meaning, alone or with its words)'),
    partial: z.literal(true).optional().describe('Present when only the beginning of the page is searchable'),
    collectionId: z.string().uuid(),
    rank: z.number(),
    updatedAt: z.string().describe('The last edit, an ISO 8601 time'),
  })
  .openapi('SearchItem');

const SearchPage = z
  .object({
    items: z.array(SearchItem),
    semantic: z.boolean().describe('True when the semantic search answered; false when the answer is full-text only'),
    nextCursor: z.string().nullable(),
  })
  .openapi('SearchPage');

export const search = defineRoute({
  method: 'get',
  path: '/v1/search',
  operationId: 'search',
  summary: 'Search the pages the caller can read',
  tags: ['search'],
  policy: { kind: 'authenticated' },
  rateLimit: { max: 30, windowSeconds: 60 },
  request: { query: SearchQuery },
  responses: { 200: { description: 'A page of results, best first; there is no total', content: { 'application/json': { schema: SearchPage } } } },
});

const router = createRouter();

router.openapi(search, async (c) => {
  const user = caller(c);
  const { q, collectionId, limit, cursor } = c.req.valid('query');
  const { authorizer, search: repo, hybrid, clock, log } = c.get('deps');
  if (cursor !== undefined) {
    // A cursor is checked here, before the person's collections are looked up: a hand-made one is 422 whatever the store behind does with it.
    // (Both kinds are read: the cursor of the full-text answer and the cursor of the hybrid one; anything else is invalid.)
    try { decodeHybridCursor(cursor); } catch { return fail('invalid'); }
  }
  // What the person may read is settled here and applied inside the query, so ranking, the limit and the cursor only ever see readable pages.
  const visible = (await authorizer.visibleCollections(user.id)).map((v) => v.collectionId);
  const started = clock.now();
  try {
    const request = { tenantId: callerTenant(c), collectionIds: visible, query: q, limit, ...(cursor === undefined ? {} : { cursor }), ...(collectionId === undefined ? {} : { collectionId }) };
    // The full-text search alone, or the full-text and the semantic lists fused (which answers with the full-text search alone whenever the semantic part cannot).
    const page: { hits: readonly HybridHit[]; semantic?: boolean; nextCursor?: string } =
      visible.length === 0 ? { hits: [] } : hybrid === undefined ? await repo.search(request) : await hybridSearch({ fullText: repo, semantic: hybrid, log }, request);
    // Counts and time only: what was searched for is never logged.
    log.debug('search.query', { ms: clock.now() - started, results: page.hits.length });
    return c.json(
      {
        items: page.hits.map((h) => ({
          pageId: h.pageId, urlId: h.urlId, title: h.title, snippet: { text: h.snippet.text, ranges: h.snippet.ranges.map(([a, b]) => [a, b] as [number, number]) },
          ...(h.matchedPassage === undefined ? {} : { matchedPassage: { text: h.matchedPassage.text } }),
          ...(h.partial ? { partial: true as const } : {}), collectionId: h.collectionId, rank: h.rank, updatedAt: new Date(h.updatedAt).toISOString(),
        })),
        semantic: page.semantic === true,
        nextCursor: 'nextCursor' in page && page.nextCursor !== undefined ? page.nextCursor : null,
      },
      200,
    );
  } catch (error) {
    if (error instanceof InvalidSearchCursor) return fail('invalid');
    if (error instanceof HybridContinuationUnavailable) {
      log.debug('search.semantic_fallback', { reason: 'continuation' });
      return fail('unavailable');
    }
    if (error instanceof SearchTimeoutError) {
      log.warn('search.timeout', {});
      return fail('unavailable');
    }
    throw error;
  }
});

export default router;
