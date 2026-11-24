import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { useTreeActions } from '../../src/tree/actions';
import type { FlatPage } from '../../src/tree/model';
import { treeKey, useCollectionTree } from '../../src/tree/useTree';
import '../support/dom';
import { fakeApi, page } from './support';

const SERVER = { pages: [page('a', null, 'p1', 'A'), page('b', null, 'p2', 'B'), page('a1', 'a', 'p1', 'A1')] };
const ok = (body?: unknown, status = 200): { status: number; body?: unknown } => ({ status, body });

function setup(routes: Record<string, ReturnType<typeof ok> | (() => ReturnType<typeof ok>)>) {
  const { api, calls } = fakeApi({ 'GET /v1/collections/{id}/tree': ok(SERVER), ...routes });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => ({ tree: useCollectionTree(api as ApiLike, 'c1'), actions: useTreeActions(api as ApiLike, 'c1') }), { wrapper });
  const cached = () => client.getQueryData<readonly FlatPage[]>(treeKey('c1')) ?? [];
  return { view, calls, cached };
}
const titles = (pages: readonly FlatPage[]) => pages.map((p) => `${p.parentId ?? '-'}/${p.title}`).sort();

describe('useTreeActions', () => {
  it('creates an untitled page under a parent, shows it, and reads the tree again', async () => {
    const created = page('n', 'b', 'p9', '');
    const { view, calls } = setup({ 'POST /v1/pages': ok(created, 201) });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let outcome;
    await act(async () => { outcome = await view.result.current.actions.create('b'); });
    expect(outcome).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.startsWith('GET /v1/collections/{id}/tree'))).toHaveLength(2);
    expect(calls).toContain('POST /v1/pages');
  });

  it('sends the collection and the parent of a new page', async () => {
    const { api, bodies } = fakeApi({ 'GET /v1/collections/{id}/tree': ok(SERVER), 'POST /v1/pages': ok(page('n', null, 'p9', ''), 201) });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useTreeActions(api, 'c1'), { wrapper });
    await act(async () => { await view.result.current.create(null); });
    expect(bodies).toEqual([{ method: 'POST', path: '/v1/pages', body: { collectionId: 'c1', parentId: null } }]);
  });

  it('shows a rename and a move at once, before the server has answered', async () => {
    const { view, cached } = setup({ 'PATCH /v1/pages/{id}': ok(page('b', null, 'p2', 'Plan')) });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = view.result.current.actions.rename('b', 'Plan'); });
    expect(titles(cached())).toContain('-/Plan'); // before the call has returned
    await act(async () => { await pending; });
  });

  it('moves a page locally under its new parent', async () => {
    const { view, cached } = setup({ 'POST /v1/pages/{id}/move': ok(page('b', 'a', 'p9', 'B')) });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = view.result.current.actions.move('b', { parentId: 'a', afterId: null, beforeId: null }); });
    expect(cached().find((p) => p.id === 'b')?.parentId).toBe('a');
    await act(async () => { await pending; });
  });

  it('reports a refused move by its status and code, and leaves the tree as the server has it', async () => {
    const { view, calls } = setup({ 'POST /v1/pages/{id}/move': { status: 409, body: { error: { code: 'would_create_cycle', message: 'x' } } } });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let outcome;
    await act(async () => { outcome = await view.result.current.actions.move('a', { parentId: 'a1', afterId: null, beforeId: null }); });
    expect(outcome).toEqual({ ok: false, status: 409, code: 'would_create_cycle' });
    await waitFor(() => { expect(titles(view.result.current.tree.data ?? [])).toEqual(['-/A', '-/B', 'a/A1']); });
    expect(calls.filter((c) => c.startsWith('GET /v1/collections/{id}/tree'))).toHaveLength(2);
  });

  it('removes a page and its sub-pages from the list at once', async () => {
    const { view, cached } = setup({ 'DELETE /v1/pages/{id}': { status: 204 } });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = view.result.current.actions.remove('a'); });
    expect(cached().map((p) => p.id)).toEqual(['b']);
    await act(async () => { await pending; });
  });

  it('asks for a move with afterId or with beforeId, never both, and with neither for last', async () => {
    const { api, bodies } = fakeApi({ 'GET /v1/collections/{id}/tree': ok(SERVER), 'POST /v1/pages/{id}/move': ok(page('b', null, 'p2', 'B')) });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useTreeActions(api, 'c1'), { wrapper });
    await act(async () => {
      await view.result.current.move('b', { parentId: null, afterId: 'a', beforeId: null });
      await view.result.current.move('b', { parentId: null, afterId: null, beforeId: 'a' });
      await view.result.current.move('b', { parentId: 'a', afterId: null, beforeId: null });
    });
    expect(bodies.map((b) => b.body)).toEqual([{ parentId: null, afterId: 'a' }, { parentId: null, beforeId: 'a' }, { parentId: 'a', afterId: null }]);
  });
});
