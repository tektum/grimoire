import type { Page } from '@playwright/test';
import { API } from '../collections/mock-api';

/** The state of an import as `GET /v1/imports/{id}` says it (R6.41). */
export interface ScriptedState {
  readonly status: 'created' | 'uploaded' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly total?: number;
  readonly done?: number;
  readonly skipped?: number;
  readonly failed?: number;
  readonly error?: string | null;
  /** The construct report of `GET /v1/imports/{id}`; the key is left out when the stand-in plays a server that does not say. */
  readonly report?: unknown;
}

/** One file of the report as `GET /v1/imports/{id}/items` says it. */
export interface ScriptedItem {
  readonly id: string;
  readonly path: string;
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly message?: string;
  readonly hasSource?: boolean;
  readonly remoteImageFailures?: Readonly<Record<string, number>>;
}

export const stateOf = (s: ScriptedState) => ({
  status: s.status,
  counts: { pagesTotal: s.total ?? 0, pagesDone: s.done ?? 0, attachments: 0, skipped: s.skipped ?? 0, failed: s.failed ?? 0 },
  startedAt: '2026-11-20T10:00:00.000Z',
  finishedAt: s.status === 'done' || s.status === 'failed' || s.status === 'cancelled' ? '2026-11-20T10:05:00.000Z' : null,
  error: s.error ?? null,
  ...(s.report === undefined ? {} : { report: s.report }),
});

const cors = (origin: string | undefined) => ({
  'access-control-allow-origin': origin ?? '*',
  'access-control-allow-headers': 'authorization, x-grimoire-client-version, idempotency-key, content-type, if-none-match',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
});

/**
 * Stands in for the import routes of the API (M7-T05) on a page whose other calls are stood in for by `mockApi` (call it first). `states` is what `GET /v1/imports/{id}` answers one after the other
 * (the last one for ever); the file store is a route that takes the PUT of the zip. What the client sent is kept, in order. When the real API is there, a specification of the stack is the same
 * without this.
 */
export async function scriptedImports(
  page: Page,
  states: readonly ScriptedState[],
  options: { createStatus?: number; startStatus?: number; startCode?: string; startRefusals?: number; items?: readonly ScriptedItem[] } = {},
) {
  const sent: { creates: unknown[]; puts: { headers: Record<string, string>; bytes: number }[]; starts: number; reads: number; cancels: number; sources: string[] } = {
    creates: [],
    puts: [],
    starts: 0,
    reads: 0,
    cancels: 0,
    sources: [],
  };
  let cancelled = false;
  await page.route(`${API}/v1/imports**`, async (route) => {
    const request = route.request();
    const origin = request.headers()['origin'];
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(origin) });
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: cors(origin), body: JSON.stringify(body) });
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/v1/imports') {
      sent.creates.push(request.postDataJSON());
      if ((options.createStatus ?? 201) >= 400) return json(options.createStatus!, { error: { code: 'too_large', message: 'Too large' } });
      return json(201, { id: 'imp1', uploads: [{ index: 0, upload: { kind: 'single', method: 'PUT', url: `${API}/__store/imports/imp1.zip`, headers: { 'content-type': 'application/zip' }, expiresAt: '2026-11-20T11:00:00.000Z' } }] });
    }
    if (request.method() === 'POST' && path.endsWith('/start')) {
      sent.starts += 1;
      if (sent.starts <= (options.startRefusals ?? 0)) return json(409, { error: { code: 'upload_missing', message: 'No' } });
      if ((options.startStatus ?? 202) >= 400) return json(options.startStatus!, { error: { code: options.startCode ?? 'not_a_zip', message: 'No' } });
      return json(202, { status: 'running' });
    }
    if (request.method() === 'POST' && path.endsWith('/cancel')) {
      sent.cancels += 1;
      cancelled = true;
      return json(202, { status: 'cancelled' });
    }
    if (request.method() === 'GET' && /^\/v1\/imports\/[^/]+\/items$/.test(path)) {
      return json(200, { items: (options.items ?? []).map((i) => ({ kind: 'page', pageId: null, markdownBytes: null, stateBytes: null, message: null, hasSource: false, remoteImageFailures: {}, ...i })), nextCursor: null });
    }
    const source = /^\/v1\/imports\/[^/]+\/items\/([^/]+)\/source$/.exec(path);
    if (request.method() === 'GET' && source) {
      sent.sources.push(source[1]!);
      return json(200, { url: `${API}/__store/source/${source[1]!}.md`, expiresAt: '2026-11-20T11:00:00.000Z' });
    }
    if (request.method() === 'GET' && /^\/v1\/imports\/[^/]+$/.test(path)) {
      const answer = states[Math.min(sent.reads, states.length - 1)]!;
      sent.reads += 1;
      return json(200, stateOf(cancelled ? { ...answer, status: 'cancelled' } : answer));
    }
    return route.fallback();
  });
  await page.route(`${API}/__store/**`, (route) => {
    const request = route.request();
    const origin = request.headers()['origin'];
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(origin) });
    if (request.method() === 'GET') return route.fulfill({ status: 200, headers: { ...cors(origin), 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="source.md"' }, body: '# the source\n' });
    // WebKit gives no body of a Blob to a route: the length is the header's.
    sent.puts.push({ headers: request.headers(), bytes: request.postDataBuffer()?.length ?? Number(request.headers()['content-length'] ?? 0) });
    return route.fulfill({ status: 200, headers: cors(origin), body: '' });
  });
  return sent;
}

/** A small zip-shaped file: the four bytes every zip starts with, and some filler (the client only sends it; the server is stood in for). */
export const smallZip = (name = 'export.zip') => ({ name, mimeType: 'application/zip', buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]) });

/** Says the zip holds Markdown files: the import cannot start before the person has said what is in it. */
export const chooseMarkdown = (page: Page): Promise<void> => page.getByRole('radio', { name: 'Markdown files' }).check();

const page = (itemId: string, path: string, urlId: string | null) => ({ itemId, path, urlId });
/** The construct report of an import of a Notion export: every kind, pages behind most of them, a line whose list is cut, rows that were left out (no address) and pages that still hold HTML. */
export const CONSTRUCT_REPORT = {
  constructs: [
    { kind: 'callout', fate: 'converted', count: 12, pages: [page('i1', 'handbook/welcome.md', 'abc123'), page('i2', 'handbook/guides/setup.md', 'def456')], capped: false },
    { kind: 'toggle', fate: 'converted', count: 7, pages: [page('i2', 'handbook/guides/setup.md', 'def456')], capped: false },
    { kind: 'page_mention', fate: 'converted', count: 1204, pages: [page('i1', 'handbook/welcome.md', 'abc123'), page('i3', 'projects/roadmap.md', 'ghi789'), page('i4', 'projects/Q3 plan.md', 'jkl012')], capped: true },
    { kind: 'database_table', fate: 'converted', count: 3, pages: [page('i3', 'projects/roadmap.md', 'ghi789')], capped: false },
    {
      kind: 'front_matter',
      fate: 'dropped',
      count: 120,
      pages: [page('i1', 'handbook/welcome.md', 'abc123'), page('i2', 'handbook/guides/setup.md', 'def456'), page('i3', 'projects/roadmap.md', 'ghi789')],
      capped: false,
    },
    { kind: 'icon_cover', fate: 'dropped', count: 96, pages: [page('i4', 'projects/Q3 plan.md', 'jkl012')], capped: false },
    { kind: 'database_row', fate: 'dropped', count: 85, pages: [page('r1', 'tasks/Row one.md', null), page('r2', 'tasks/Row two.md', null)], capped: true },
    { kind: 'unresolved_link', fate: 'kept', count: 5, pages: [page('i3', 'projects/roadmap.md', 'ghi789')], capped: false },
    { kind: 'raw_html', fate: 'kept', count: 4, pages: [page('i2', 'handbook/guides/setup.md', 'def456'), page('i5', 'handbook/embeds.md', 'mno345')], capped: false },
  ],
  rawHtmlPages: [
    { ...page('i2', 'handbook/guides/setup.md', 'def456'), fragments: 3 },
    { ...page('i5', 'handbook/embeds.md', 'mno345'), fragments: 1 },
  ],
  rawHtmlCapped: false,
} as const;
