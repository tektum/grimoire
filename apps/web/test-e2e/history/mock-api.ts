import type { Page, Route } from '@playwright/test';
import { API, mockApi } from '../collections/mock-api';

export interface MockRevision {
  id: string;
  createdAt: number;
  title: string;
  reason: 'idle' | 'last_editor_left' | 'before_restore' | 'manual' | 'import';
  lastAuthor: { id: string; name: string } | null;
  authors: { id: string; name: string }[];
  markdown: string;
}
export interface HistoryState {
  /** What `/v1/me` says; also the page's `myPermission` (a viewer has read-only). */
  role: 'admin' | 'member' | 'viewer';
  /** The page's current Markdown. */
  current: string;
  /** Newest first. */
  revisions: MockRevision[];
  /** How many restore calls are answered 409 `markdown_stale` before one succeeds (default 0). */
  staleRestores?: number;
}
export interface HistoryApi {
  /** Every request to the history routes, as `METHOD /path`, in order. */
  readonly seen: string[];
  /** Requests made to any host other than the API and the page's own (the safety spec: nothing is fetched from a revision's text). */
  readonly foreign: string[];
  /** The ids restored, in order (only calls that were answered 200). */
  readonly restored: string[];
}

export const SLUG = 'quarterly-plan-abc123';
export const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const json = (route: Route, status: number, body: unknown, headers: Record<string, string>) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

/** Stands in for the API for the history screens: the page `quarterly-plan-abc123`, its revisions, its current Markdown. The rest is `mockApi`'s. */
export async function historyApi(page: Page, state: HistoryState): Promise<HistoryApi> {
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  const seen: string[] = [];
  const foreign: string[] = [];
  const restored: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http')) foreign.push(request.url());
  });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    // The page's live connection goes to an address nothing listens on, even when a real stack runs on the same host (the Web browser tests job): the page would otherwise
    // reach it, the stack would refuse this stand-in's token, and the page would stop showing the saved text the specs look at.
    if (pathname === '/v1/config') return json(route, 200, { collabUrl: 'ws://127.0.0.1:1/collab', fileStoreOrigin: null, local: true, minClientVersion: '0.0.0', providerBaseUrl: null, providerProjectId: null }, cors);
    if (pathname === '/v1/me') return json(route, 200, { id: 'me', name: 'Alice Example', email: 'alice@dev.invalid', role: state.role }, cors);
    if (pathname === '/v1/pages/by-url-id/abc123') {
      return json(route, 200, { id: PAGE_ID, title: 'Quarterly plan', urlId: 'abc123', collectionId: 'c1', myPermission: state.role === 'viewer' ? 'read-only' : 'read-write', breadcrumb: [], markdownStale: false, markdownStaleSince: null, parentId: null, position: 'p', slug: SLUG, updatedAt: 0, createdAt: 0 }, cors);
    }
    if (!pathname.startsWith(`/v1/pages/${PAGE_ID}`)) return route.fallback();
    seen.push(`${request.method()} ${pathname.slice(`/v1/pages/${PAGE_ID}`.length)}${searchParams.size === 0 ? '' : `?${searchParams.toString()}`}`);
    if (pathname.endsWith('/markdown')) return route.fulfill({ status: 200, contentType: 'text/markdown', headers: cors, body: state.current });
    if (pathname.endsWith('/revisions') && request.method() === 'GET') {
      return json(route, 200, { items: state.revisions.map((r) => ({ id: r.id, createdAt: r.createdAt, title: r.title, reason: r.reason, lastAuthor: r.lastAuthor, authors: r.authors })), nextCursor: null }, cors);
    }
    const restore = /\/revisions\/([^/]+)\/restore$/.exec(pathname);
    if (restore !== null && request.method() === 'POST') {
      if (state.role === 'viewer') return json(route, 403, { error: { code: 'forbidden', message: 'x' } }, cors);
      const wanted = state.revisions.find((r) => r.id === restore[1]);
      if (wanted === undefined) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      if ((state.staleRestores ?? 0) > 0) {
        state.staleRestores = (state.staleRestores ?? 0) - 1;
        return json(route, 409, { error: { code: 'markdown_stale', message: 'x' } }, cors);
      }
      restored.push(wanted.id);
      return json(route, 200, { title: wanted.title, markdown: wanted.markdown, safetyRevisionId: null }, cors);
    }
    const one = /\/revisions\/([^/]+)$/.exec(pathname);
    const found = state.revisions.find((r) => r.id === one?.[1]);
    if (found !== undefined && request.method() === 'GET') return json(route, 200, found, cors);
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
  });
  return { seen, foreign, restored };
}
