import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKey, useApiMutation, useApiQuery, NO_CACHE, type ApiLike } from '../../src/api/query';
import { typedResult } from '../../src/api/client';

afterEach(cleanup);
const ok = (data: unknown) => vi.fn(async () => ({ data, response: new Response('{}', { status: 200 }) }));
const bad = (status: number) => vi.fn(async () => ({ error: {}, response: new Response('{}', { status }) }));
const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const fake = (over: Partial<ApiLike>): ApiLike => ({ GET: ok(1), POST: ok(1), PUT: ok(1), PATCH: ok(1), DELETE: ok(1), ...over }) as ApiLike;

describe('useApiQuery / useApiMutation', () => {
  it('keys a query as [method, path, params] and returns the data', async () => {
    const client = new QueryClient();
    const init = { params: { path: { id: 'p1' } } };
    const { result } = renderHook(() => useApiQuery(fake({ GET: ok({ a: 1 }) }), '/v1/pages/{id}', init), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toEqual({ a: 1 }));
    expect(client.getQueryCache().getAll()[0]?.queryKey).toEqual(['GET', '/v1/pages/{id}', init]);
    expect(queryKey('GET', '/x', undefined)).toEqual(['GET', '/x', null]);
  });
  it('passes the abort signal of the query to the read', async () => {
    const GET = ok(1);
    const { result } = renderHook(() => useApiQuery(fake({ GET }), '/x', { params: { query: { a: 1 } } }), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data).toBe(1));
    const init = (GET.mock.calls[0] as unknown as [string, { signal: AbortSignal; params: unknown }])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.params).toEqual({ query: { a: 1 } });
  });
  it('drops a query of document content as soon as nothing uses it (gcTime 0)', async () => {
    const client = new QueryClient();
    const { result, unmount } = renderHook(() => useApiQuery(fake({ GET: ok('# text') }), '/v1/pages/{id}/markdown', undefined, NO_CACHE), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toBe('# text'));
    unmount();
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
  });
  it('errors on a failed read', async () => {
    const { result } = renderHook(() => useApiQuery(fake({ GET: bad(500) }), '/x'), { wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
  it('runs a mutation with the method and path, and errors on failure', async () => {
    const PATCH = ok({ done: true });
    const { result } = renderHook(() => useApiMutation(fake({ PATCH }), '/v1/pages/{id}', 'PATCH'), { wrapper: wrapper(new QueryClient()) });
    expect(await result.current.mutateAsync({ body: { title: 'x' } })).toEqual({ done: true });
    expect(PATCH).toHaveBeenCalledWith('/v1/pages/{id}', { body: { title: 'x' } });
    const failing = renderHook(() => useApiMutation(fake({ DELETE: bad(409) }), '/x', 'DELETE'), { wrapper: wrapper(new QueryClient()) });
    await expect(failing.result.current.mutateAsync(undefined)).rejects.toThrow('DELETE /x: 409');
  });
});

describe('typedResult', () => {
  it('gives MarkdownStale for 409 markdown_stale and NotFound for a 404/403 read, else null', () => {
    expect(typedResult(409, 'markdown_stale', 'PATCH')).toEqual({ kind: 'markdown-stale' });
    expect(typedResult(404, 'not_found', 'GET')).toEqual({ kind: 'not-found' });
    expect(typedResult(403, 'forbidden', 'GET')).toEqual({ kind: 'not-found' });
    expect(typedResult(404, 'not_found', 'PATCH')).toBeNull();
  });
});
