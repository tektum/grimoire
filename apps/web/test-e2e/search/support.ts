import type { Page } from '@playwright/test';
import { API } from '../collections/mock-api';

/** One answer of the scripted search: what `GET /v1/search` says to the client. */
export interface SearchAnswer {
  readonly status?: number;
  readonly items?: readonly unknown[];
  readonly nextCursor?: string | null;
  readonly semantic?: boolean;
}

export const hit = (pageId: string, urlId: string, title: string, text: string, ranges: [number, number][], extra: Record<string, unknown> = {}) => ({
  pageId,
  urlId,
  title,
  snippet: { text, ranges },
  collectionId: 'c1',
  rank: 0.5,
  updatedAt: '2026-11-20T10:00:00.000Z',
  ...extra,
});

/**
 * Stands in for `GET /v1/search` (M7-T01) on a page whose other calls are stood in for by `mockApi` (call it first: the route made last answers first). `answer` says what to return for a query and a
 * cursor; the requests are kept, as `{ q, cursor, limit }`, in the order they were made. When the real endpoint is there, a specification of the stack is the same without this.
 */
export async function scriptedSearch(page: Page, answer: (q: string, cursor: string | null) => SearchAnswer) {
  const requests: { q: string; cursor: string | null; limit: string | null }[] = [];
  await page.route(`${API}/v1/search**`, (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const url = new URL(request.url());
    const q = url.searchParams.get('q') ?? '';
    const cursor = url.searchParams.get('cursor');
    requests.push({ q, cursor, limit: url.searchParams.get('limit') });
    const result = answer(q, cursor);
    return route.fulfill({
      status: result.status ?? 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': request.headers()['origin'] ?? '*' },
      body: JSON.stringify(
        result.status !== undefined && result.status >= 400
          ? { error: { code: 'unavailable', message: 'Unavailable' } }
          : { items: result.items ?? [], nextCursor: result.nextCursor ?? null, semantic: result.semantic ?? false },
      ),
    });
  });
  return { requests };
}
