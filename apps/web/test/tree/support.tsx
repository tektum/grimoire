import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import type { FlatPage } from '../../src/tree/model';

export const COLLECTIONS = [
  { id: 'c1', name: 'Dev', description: null, icon: null, color: null, position: 'p1', defaultPermission: 'read-write', myPermission: 'read-write' },
  { id: 'c2', name: 'Private', description: null, icon: '🔒', color: null, position: 'p2', defaultPermission: null, myPermission: 'read-only' },
];
export const page = (id: string, parentId: string | null, position: string, title: string): FlatPage => ({ id, urlId: id, parentId, position, title, icon: null });

type Answer = { status: number; body?: unknown };
/** A fake typed client: `routes` maps "GET /path" to an answer, or to a function that makes one. */
export function fakeApi(routes: Record<string, Answer | (() => Answer)>) {
  const calls: string[] = [];
  const bodies: { method: string; path: string; body: unknown }[] = [];
  const call = vi.fn((method: string) => (path: string, init?: { params?: { path?: { id?: string } }; body?: unknown }) => {
    const key = `${method} ${path}`;
    if (init?.body !== undefined) bodies.push({ method, path, body: init.body });
    calls.push(init?.params?.path?.id === undefined ? key : `${key} ${init.params.path.id}`);
    const entry = routes[`${key} ${init?.params?.path?.id ?? ''}`.trim()] ?? routes[key];
    const answer = typeof entry === 'function' ? entry() : entry ?? { status: 404 };
    return Promise.resolve({ data: answer.status < 300 ? answer.body : undefined, error: answer.status < 300 ? undefined : answer.body, response: new Response(null, { status: answer.status }) });
  });
  const api = { GET: call('GET'), POST: call('POST'), PUT: call('PUT'), PATCH: call('PATCH'), DELETE: call('DELETE') } as unknown as ApiLike;
  return { api, calls, bodies };
}

export function renderAt(ui: ReactElement, path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
