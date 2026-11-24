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
  readonly body: unknown;
}
export type Answer = { status: number; body?: unknown };
type Handler = Answer | ((request: Request) => Answer);

/** A fake typed client for the admin screens: `routes` maps "METHOD /path" to an answer, or to a function of the request; every request is recorded. */
export function fakeApi(routes: Record<string, Handler>) {
  const requests: Request[] = [];
  const call = (method: string) => (path: string, init?: { params?: Request['params']; body?: unknown }) => {
    const request: Request = { method, path, params: init?.params ?? {}, body: init?.body };
    requests.push(request);
    const entry = routes[`${method} ${path}`];
    const answer: Answer = typeof entry === 'function' ? entry(request) : (entry ?? { status: 404 });
    const ok = answer.status < 300;
    return Promise.resolve({ data: ok ? answer.body : undefined, error: ok ? undefined : answer.body, response: new Response(null, { status: answer.status }) });
  };
  const api = { GET: vi.fn(call('GET')), POST: vi.fn(call('POST')), PUT: vi.fn(call('PUT')), PATCH: vi.fn(call('PATCH')), DELETE: vi.fn(call('DELETE')) } as unknown as ApiLike;
  return { api, requests, of: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path) };
}

export function renderAt(ui: ReactElement, path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

export const user = (id: string, name: string, role: 'admin' | 'member' | 'viewer' = 'member', suspended = false) => ({ id, name, email: `${name.toLowerCase()}@dev.invalid`, role, suspended });
export const ok = (body: unknown, status = 200): Answer => ({ status, body });
