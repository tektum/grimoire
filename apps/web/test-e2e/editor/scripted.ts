import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const SCRIPTED_PAGE_ID = '11111111-1111-4111-8111-111111111111';
export const SCRIPTED_URL_ID = 'abc123';

export interface ScriptedApiOptions {
  /** The address of the collaboration server the client is told to use (`GET /v1/config`). */
  readonly collabUrl: string;
  readonly minClientVersion?: string;
  readonly markdown?: string;
  /** Sent as `X-Grimoire-Markdown-Stale` and as `markdownStale` of the page. */
  readonly stale?: boolean;
  readonly title?: string;
  readonly permission?: 'read-write' | 'read-only';
  /** The answer for `GET /v1/pages/by-url-id/...`: a status other than 200 stands for a page that is not there, or that may not be read. */
  readonly pageStatus?: number;
}

export interface ScriptedApi {
  /** `http://127.0.0.1:<port>`: give it to the page as `apiUrl` of `config.json`. */
  readonly url: string;
  /** `METHOD /path` of every request, in order. */
  readonly requests: string[];
  stop(): Promise<void>;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-grimoire-client-version, idempotency-key, content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': 'x-grimoire-markdown-stale',
};

/**
 * The part of the API the page screen reads, scripted: a real loopback origin (a page fulfilled by interception cannot open a WebSocket or fetch from loopback),
 * so a specification can drive the client through answers the real server cannot be made to give. Any bearer token is accepted: the one who signs the
 * page in does it without the check against `GET /v1/me`.
 */
export async function scriptedApi(options: ScriptedApiOptions): Promise<ScriptedApi> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { ...CORS, 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (url.pathname === '/v1/config') {
      return json(200, { collabUrl: options.collabUrl, minClientVersion: options.minClientVersion ?? '0.0.0', local: true, providerProjectId: null, providerBaseUrl: null, fileStoreOrigin: null });
    }
    if (url.pathname === '/v1/me') return json(200, { id: '22222222-2222-4222-8222-222222222222', email: 'scripted@dev.invalid', name: 'Scripted Person', role: 'member' });
    if (url.pathname === `/v1/pages/by-url-id/${SCRIPTED_URL_ID}`) {
      if (options.pageStatus !== undefined && options.pageStatus !== 200) return json(options.pageStatus, { error: { code: 'not_found', message: 'not found' } });
      return json(200, {
        id: SCRIPTED_PAGE_ID,
        urlId: SCRIPTED_URL_ID,
        title: options.title ?? 'Scripted page',
        collectionId: SCRIPTED_PAGE_ID,
        parentId: null,
        position: 'a',
        savedAt: 0,
        stateEpoch: 1,
        icon: null,
        createdBy: SCRIPTED_PAGE_ID,
        lastEditedAt: null,
        lastEditedBy: null,
        breadcrumb: [],
        markdownStale: options.stale === true,
        markdownStaleSince: null,
        myPermission: options.permission ?? 'read-write',
      });
    }
    if (url.pathname === `/v1/pages/${SCRIPTED_PAGE_ID}/markdown`) {
      return void res
        .writeHead(200, { ...CORS, 'content-type': 'text/markdown', 'x-grimoire-markdown-stale': options.stale === true ? 'true' : 'false' })
        .end(options.markdown ?? 'The saved text of the scripted page.\n');
    }
    if (url.pathname === '/v1/users/names') return json(200, { items: [] });
    return json(404, { error: { code: 'not_found', message: 'not found' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Points the page at a scripted API: `config.json` is the one build-time setting of the client (a static file, so it can be fulfilled by interception). */
export async function useScriptedApi(page: import('@playwright/test').Page, api: ScriptedApi, extra: { hiddenDisconnectMs?: number } = {}): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiUrl: api.url, ...extra }) }));
}
