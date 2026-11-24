import type { Page, Route } from '@playwright/test';
import type { FlatPage } from '../../src/tree/model';

/** Where the page believes the API is. Every request to it is answered here: nothing listens on this address, and no stack is needed. */
export const API = 'http://127.0.0.1:8080';

export interface MockCollection {
  readonly id: string;
  readonly name: string;
  readonly myPermission: 'read-write' | 'read-only';
}
export interface MockTrashItem {
  readonly id: string;
  readonly title: string;
  readonly collectionId: string;
  readonly deletedAt: number;
  readonly deletedBy: string | null;
  readonly daysLeft: number;
}
export interface MockState {
  collections: MockCollection[];
  pages: FlatPage[];
  /** Collections that exist but that this person may not read: reading their tree answers 404, exactly as for an id that does not exist. */
  hidden?: string[];
  /** The deleted batches, newest first, with the pages of each (the root first). Absent: an empty trash. */
  trash?: { item: MockTrashItem; pages: FlatPage[] }[];
}
export interface MockApi {
  readonly state: MockState;
  /** How many times the tree of `collectionId` has been read. */
  treeReads(collectionId: string): number;
  /** The requests that changed something, as `METHOD /path`, in order. */
  writes(): string[];
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

/**
 * Stands in for the API for one page: the configuration, the signed-in user, the collections and their trees, with the headers a browser needs to accept the answers
 * (the page and the API are different origins). Enough for the specs of the collections screens, which check what the client asks for and shows.
 */
export async function mockApi(page: Page, state: MockState): Promise<MockApi> {
  const reads = new Map<string, number>();
  const written: string[] = [];
  let created = 0;
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
    const one_ = /^\/v1\/collections\/([^/]+)$/.exec(pathname);
    if (one_?.[1] !== undefined && request.method() === 'GET') {
      const found = state.collections.find((c) => c.id === one_[1]);
      if (found === undefined || (state.hidden ?? []).includes(found.id)) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      return json(route, 200, found, cors);
    }
    const byUrlId = /^\/v1\/pages\/by-url-id\/([^/]+)$/.exec(pathname);
    if (byUrlId?.[1] !== undefined) {
      const found = state.pages.find((p) => p.urlId === byUrlId[1]);
      if (found === undefined) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      return json(route, 200, { ...found, collectionId: state.collections[0]?.id ?? '', createdBy: 'u1', myPermission: 'read-write' }, cors);
    }
    const tree = /^\/v1\/collections\/([^/]+)\/tree$/.exec(pathname);
    if (tree?.[1] !== undefined) {
      const id = tree[1];
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (!state.collections.some((c) => c.id === id) || (state.hidden ?? []).includes(id)) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      return json(route, 200, { pages: state.pages }, cors);
    }
    const body = (request.postData() ?? '') === '' ? {} : (JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
    const meta = (p: FlatPage) => ({ ...p, collectionId: state.collections[0]?.id ?? '', createdBy: 'u1' });
    const siblings = (parentId: string | null) => state.pages.filter((p) => p.parentId === parentId).sort((x, y) => (x.position < y.position ? -1 : 1));
    /** Gives the siblings of one parent keys in the order given, as the server's own ordering would leave them. */
    const renumber = (order: FlatPage[]) => order.forEach((p, i) => { state.pages = state.pages.map((q) => (q.id === p.id ? { ...q, position: `p${String(i).padStart(4, '0')}` } : q)); });
    if (pathname === '/v1/trash' && request.method() === 'GET') return json(route, 200, { items: (state.trash ?? []).map((t) => t.item), nextCursor: null }, cors);
    const restoring = /^\/v1\/trash\/([^/]+)\/restore$/.exec(pathname);
    if (restoring?.[1] !== undefined && request.method() === 'POST') {
      written.push(`POST ${pathname}`);
      const batch = (state.trash ?? []).find((t) => t.item.id === restoring[1]);
      if (batch === undefined) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
      state.trash = (state.trash ?? []).filter((t) => t !== batch);
      // Back at its old parent; at the top level when that parent is no longer there.
      const root = batch.pages[0];
      const parentAlive = root?.parentId !== null && state.pages.some((p) => p.id === root?.parentId);
      state.pages = [...state.pages, ...batch.pages.map((p) => (p === root ? { ...p, parentId: parentAlive ? p.parentId : null, position: 'p9998' } : p))];
      return json(route, 200, meta(root ?? batch.pages[0]!), cors);
    }
    if (pathname === '/v1/pages' && request.method() === 'POST') {
      written.push('POST /v1/pages');
      created += 1;
      const id = `new${String(created)}`;
      const parentId = (body['parentId'] as string | null | undefined) ?? null;
      const page: FlatPage = { id, urlId: id.padEnd(8, '0'), parentId, position: 'p9999', title: (body['title'] as string | undefined) ?? '', icon: null };
      state.pages = [...state.pages, page];
      renumber(siblings(parentId));
      return json(route, 201, meta(state.pages.find((p) => p.id === id) ?? page), cors);
    }
    const one = /^\/v1\/pages\/([^/]+)(\/move)?$/.exec(pathname);
    const found = one?.[1] === undefined ? undefined : state.pages.find((p) => p.id === one[1]);
    if (one !== null && found === undefined) return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
    if (found !== undefined && one?.[2] === undefined && request.method() === 'PATCH') {
      written.push(`PATCH ${pathname}`);
      state.pages = state.pages.map((p) => (p.id === found.id ? { ...p, title: String(body['title'] ?? p.title) } : p));
      return json(route, 200, meta({ ...found, title: String(body['title'] ?? found.title) }), cors);
    }
    if (found !== undefined && one?.[2] === undefined && request.method() === 'DELETE') {
      written.push(`DELETE ${pathname}`);
      const gone = new Set([found.id]);
      for (let grew = true; grew;) { grew = false; for (const p of state.pages) if (p.parentId !== null && gone.has(p.parentId) && !gone.has(p.id)) { gone.add(p.id); grew = true; } }
      const batch = state.pages.filter((p) => gone.has(p.id));
      state.pages = state.pages.filter((p) => !gone.has(p.id));
      state.trash = [{ item: { id: found.id, title: found.title, collectionId: state.collections[0]?.id ?? '', deletedAt: Date.now(), deletedBy: null, daysLeft: 30 }, pages: batch }, ...(state.trash ?? [])];
      return route.fulfill({ status: 204, headers: cors });
    }
    if (found !== undefined && one?.[2] === '/move' && request.method() === 'POST') {
      written.push(`POST ${pathname}`);
      const parentId = (body['parentId'] as string | null) ?? null;
      for (let up = parentId; up !== null; up = state.pages.find((p) => p.id === up)?.parentId ?? null) {
        if (up === found.id) return json(route, 409, { error: { code: 'would_create_cycle', message: 'cycle' } }, cors);
      }
      const others = siblings(parentId).filter((p) => p.id !== found.id);
      const after = body['afterId'] as string | null | undefined;
      const before = body['beforeId'] as string | undefined;
      const at = before !== undefined ? others.findIndex((p) => p.id === before) : after === undefined || after === null ? others.length : others.findIndex((p) => p.id === after) + 1;
      state.pages = state.pages.map((p) => (p.id === found.id ? { ...p, parentId } : p));
      const moved = state.pages.find((p) => p.id === found.id) ?? found;
      renumber([...others.slice(0, at), moved, ...others.slice(at)]);
      return json(route, 200, meta(state.pages.find((p) => p.id === found.id) ?? moved), cors);
    }
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
  });
  return { state, treeReads: (id) => reads.get(id) ?? 0, writes: () => written };
}
