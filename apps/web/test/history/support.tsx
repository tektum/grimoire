import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly params: { path?: Record<string, string>; query?: Record<string, unknown> };
  readonly parseAs?: string;
}
export type Answer = { status: number; body?: unknown };
type Handler = Answer | ((request: Request) => Answer | Promise<Answer>);

/** A fake typed client: `routes` maps "METHOD /path template" to an answer, or to a function of the request; every request is recorded. */
export function fakeApi(routes: Record<string, Handler>) {
  const requests: Request[] = [];
  const call = (method: string) => (path: string, init?: { params?: Request['params']; parseAs?: string }) => {
    const request: Request = { method, path, params: init?.params ?? {}, ...(init?.parseAs === undefined ? {} : { parseAs: init.parseAs }) };
    requests.push(request);
    const entry = routes[`${method} ${path}`];
    return Promise.resolve(typeof entry === 'function' ? entry(request) : (entry ?? { status: 404 })).then((answer) => {
      const ok = answer.status < 300;
      return { data: ok ? answer.body : undefined, error: ok ? undefined : answer.body, response: new Response(null, { status: answer.status }) };
    });
  };
  const api = { GET: vi.fn(call('GET')), POST: vi.fn(call('POST')), PUT: vi.fn(call('PUT')), PATCH: vi.fn(call('PATCH')), DELETE: vi.fn(call('DELETE')) } as unknown as ApiLike;
  return { api, requests, of: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path) };
}

export function renderAt(ui: ReactElement, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

export const ok = (body: unknown, status = 200): Answer => ({ status, body });
export const PAGE = { id: 'p1', title: 'Quarterly plan', myPermission: 'read-write' as const };
export const rev = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: Date.UTC(2026, 10, 20, 14, 30),
  title: 'Quarterly plan',
  reason: 'idle',
  lastAuthor: { id: 'u1', name: 'Alice Example' },
  authors: [{ id: 'u1', name: 'Alice Example' }, { id: 'u2', name: 'Bob Builder' }],
  ...over,
});
