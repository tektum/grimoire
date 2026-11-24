import type { Page, Route } from '@playwright/test';
import type { FlatPage } from '../../src/tree/model';

/** Where the page believes the API is. Every request to it is answered here: nothing listens on this address, and no stack is needed. */
export const API = 'http://127.0.0.1:8080';

export interface MockCollection {
  readonly id: string;
  readonly name: string;
  readonly myPermission: 'read-write' | 'read-only';
}
export interface MockState {
  collections: MockCollection[];
  pages: FlatPage[];
}
export interface MockApi {
  readonly state: MockState;
  /** How many times the tree of `collectionId` has been read. */
  treeReads(collectionId: string): number;
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

/**
 * Stands in for the API for one page: the configuration, the signed-in user, the collections and their trees, with the headers a browser needs to accept the answers
 * (the page and the API are different origins). Enough for the specs of the collections screens, which check what the client asks for and shows.
 */
export async function mockApi(page: Page, state: MockState): Promise<MockApi> {
  const reads = new Map<string, number>();
  await page.route('**/config.json', (route) => json(route, 200, { apiUrl: API }));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(request.url());
    if (pathname === '/v1/config') return json(route, 200, { collabUrl: 'ws://127.0.0.1:8080/collab', fileStoreOrigin: null, local: true, minClientVersion: '0.0.0', providerBaseUrl: null, providerProjectId: null }, cors);
    if (pathname === '/v1/me') return json(route, 200, { id: 'u1', name: 'e2e-alice', email: 'e2e-alice@dev.invalid', role: 'member' }, cors);
    if (pathname === '/v1/collections') return json(route, 200, { items: state.collections }, cors);
    const tree = /^\/v1\/collections\/([^/]+)\/tree$/.exec(pathname);
    if (tree?.[1] !== undefined) {
      const id = tree[1];
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (!state.collections.some((c) => c.id === id)) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      return json(route, 200, { pages: state.pages }, cors);
    }
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
  });
  return { state, treeReads: (id) => reads.get(id) ?? 0 };
}
