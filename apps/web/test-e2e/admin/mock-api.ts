import type { Page, Route } from '@playwright/test';
import { API, mockApi } from '../collections/mock-api';

export interface MockUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  suspended: boolean;
}
export interface AdminState {
  /** Who is signed in: the role `/v1/me` answers. */
  role: 'admin' | 'member' | 'viewer';
  users: MockUser[];
}
export interface AdminApi {
  readonly state: AdminState;
  /** Every request to an admin route (`/v1/users`, `/v1/groups`, collection access), as `METHOD /path?query`, in order. */
  admin(): string[];
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string>) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
const ADMIN_PATHS = /^\/v1\/(users|groups)(\/|$)|^\/v1\/collections\/[^/]+\/access/;

/**
 * Stands in for the API for the admin screens: the signed-in role, and the users with the rules the server has (a role or suspension that would leave no
 * administrator is refused 409 `last_admin`, the list is searched by `q` and paged by `cursor`). The rest (configuration, collections) is `mockApi`'s.
 */
export async function adminApi(page: Page, state: AdminState): Promise<AdminApi> {
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  const seen: string[] = [];
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (pathname === '/v1/me') return json(route, 200, { id: 'me', name: 'Alice Example', email: 'alice@dev.invalid', role: state.role }, cors);
    if (!ADMIN_PATHS.test(pathname)) return route.fallback();
    seen.push(`${request.method()} ${pathname}${searchParams.size === 0 ? '' : `?${searchParams.toString()}`}`);
    if (state.role !== 'admin') return json(route, 403, { error: { code: 'forbidden', message: 'x' } }, cors);
    if (pathname === '/v1/users' && request.method() === 'GET') {
      const q = (searchParams.get('q') ?? '').toLowerCase();
      const all = state.users.filter((u) => q === '' || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
      const from = Number(searchParams.get('cursor') ?? '0');
      const limit = 50;
      return json(route, 200, { items: all.slice(from, from + limit), nextCursor: from + limit < all.length ? String(from + limit) : null }, cors);
    }
    const one = /^\/v1\/users\/([^/]+)$/.exec(pathname);
    const found = one?.[1] === undefined ? undefined : state.users.find((u) => u.id === one[1]);
    if (found !== undefined && request.method() === 'PATCH') {
      const patch = JSON.parse(request.postData() ?? '{}') as { role?: MockUser['role']; suspended?: boolean };
      const admins = state.users.filter((u) => u.role === 'admin' && !u.suspended);
      const loses = found.role === 'admin' && !found.suspended && (patch.role !== undefined && patch.role !== 'admin' || patch.suspended === true);
      if (loses && admins.length === 1) return json(route, 409, { error: { code: 'last_admin', message: 'x' } }, cors);
      Object.assign(found, patch);
      return json(route, 200, found, cors);
    }
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
  });
  return { state, admin: () => seen };
}
