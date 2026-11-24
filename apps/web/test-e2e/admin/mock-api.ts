import type { Page, Route } from '@playwright/test';
import { API, mockApi } from '../collections/mock-api';

export interface MockUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  suspended: boolean;
}
export interface MockGroup {
  id: string;
  name: string;
}
export interface MockEntry {
  id: string;
  principalType: 'user' | 'group';
  principalId: string;
  permission: 'read' | 'read_write';
}
export interface AdminState {
  /** Who is signed in: the role `/v1/me` answers. */
  role: 'admin' | 'member' | 'viewer';
  users: MockUser[];
  groups?: MockGroup[];
  /** Group id to the ids of its members. */
  members?: Record<string, string[]>;
  /** The access of collection `c1`. */
  access?: { defaultPermission: 'read' | 'read_write' | null; entries: MockEntry[] };
}
export interface AdminApi {
  readonly state: AdminState;
  /** Every request to an admin route (`/v1/users`, `/v1/groups`, collection access), as `METHOD /path?query`, in order. */
  admin(): string[];
}

const json = (route: Route, status: number, body: unknown, headers: Record<string, string>) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
const ADMIN_PATHS = /^\/v1\/(users|groups)(\/|$)|^\/v1\/collections\/[^/]+\/access|^\/v1\/collections\/c1$/;

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
    if (!ADMIN_PATHS.test(pathname) || (pathname === '/v1/collections/c1' && request.method() !== 'PATCH')) return route.fallback();
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
    const body = (): Record<string, unknown> => JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
    const groups = (state.groups ??= []);
    const members = (state.members ??= {});
    const nameOf = (type: string, id: string): string => (type === 'group' ? groups.find((g) => g.id === id)?.name : state.users.find((u) => u.id === id)?.name) ?? id;
    if (pathname === '/v1/groups') {
      if (request.method() === 'GET') return json(route, 200, { items: groups.map((g) => ({ ...g, memberCount: members[g.id]?.length ?? 0 })) }, cors);
      const wanted = String(body()['name']);
      if (groups.some((g) => g.name.toLowerCase() === wanted.toLowerCase())) return json(route, 409, { error: { code: 'name_taken', message: 'x' } }, cors);
      const made = { id: `g${String(groups.length + 1)}`, name: wanted };
      groups.push(made);
      return json(route, 201, { ...made, memberCount: 0 }, cors);
    }
    const group = /^\/v1\/groups\/([^/]+)(?:\/members(?:\/([^/]+))?)?$/.exec(pathname);
    const g = group?.[1] === undefined ? undefined : groups.find((x) => x.id === group[1]);
    if (group !== null && g !== undefined) {
      const isMembers = pathname.includes('/members');
      const ids = (members[g.id] ??= []);
      if (!isMembers && request.method() === 'PATCH') {
        g.name = String(body()['name']);
        return json(route, 200, { ...g, memberCount: ids.length }, cors);
      }
      if (!isMembers && request.method() === 'DELETE') {
        groups.splice(groups.indexOf(g), 1);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (isMembers && group[2] === undefined && request.method() === 'GET') return json(route, 200, { items: state.users.filter((u) => ids.includes(u.id)) }, cors);
      if (isMembers && group[2] !== undefined && request.method() === 'PUT') {
        if (!ids.includes(group[2])) ids.push(group[2]);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (isMembers && group[2] !== undefined && request.method() === 'DELETE') {
        members[g.id] = ids.filter((id) => id !== group[2]);
        return route.fulfill({ status: 204, headers: cors });
      }
    }
    const access = (state.access ??= { defaultPermission: null, entries: [] });
    if (pathname === '/v1/collections/c1' && request.method() === 'PATCH') {
      access.defaultPermission = (body()['defaultPermission'] as 'read' | 'read_write' | null | undefined) ?? null;
      return route.fallback();
    }
    if (pathname === '/v1/collections/c1/access' && request.method() === 'GET') {
      return json(route, 200, { defaultPermission: access.defaultPermission, entries: access.entries.map((e) => ({ ...e, name: nameOf(e.principalType, e.principalId) })) }, cors);
    }
    if (pathname === '/v1/collections/c1/access' && request.method() === 'PUT') {
      const b = body() as { principalType: 'user' | 'group'; principalId: string; permission: 'read' | 'read_write' };
      const had = access.entries.find((e) => e.principalType === b.principalType && e.principalId === b.principalId);
      if (had === undefined) access.entries.push({ id: `e${String(access.entries.length + 1)}`, ...b });
      else had.permission = b.permission;
      return json(route, 200, { ...(had ?? access.entries.at(-1)), name: nameOf(b.principalType, b.principalId) }, cors);
    }
    const entry = /^\/v1\/collections\/c1\/access\/([^/]+)$/.exec(pathname);
    if (entry !== null && request.method() === 'DELETE') {
      access.entries = access.entries.filter((e) => e.id !== entry[1]);
      return route.fulfill({ status: 204, headers: cors });
    }
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } }, cors);
  });
  return { state, admin: () => seen };
}
