import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { SessionContext, type Session } from '../../src/auth/session';
import { usePage } from '../../src/screens/page/usePage';
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

  it('reads the tree again and gives an outcome, without throwing, when the request itself fails (the network)', async () => {
    const { api, calls } = fakeApi({ 'GET /v1/collections/{id}/tree': ok(SERVER) });
    (api as unknown as { DELETE: () => Promise<never> }).DELETE = () => Promise.reject(new TypeError('network'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => ({ tree: useCollectionTree(api, 'c1'), actions: useTreeActions(api, 'c1') }), { wrapper });
    await waitFor(() => { expect(view.result.current.tree.data).toBeDefined(); });
    let outcome;
    await act(async () => { outcome = await view.result.current.actions.remove('a'); });
    expect(outcome).toEqual({ ok: false, status: 0, code: undefined });
    await waitFor(() => { expect((view.result.current.tree.data ?? []).map((x) => x.id)).toEqual(['a', 'b', 'a1']); }); // the page that was shown as gone is back
    expect(calls.filter((c) => c.startsWith('GET /v1/collections/{id}/tree'))).toHaveLength(2);
  });

  describe('renames of one page from the page head and from the tree, racing', () => {
    // A server that keeps the title the last PATCH it was given set, and that answers each PATCH only when the test lets it. The open page reads its record through `usePage`.
    const race = (options: { refuse?: boolean } = {}) => {
      let serverTitle = 'Start';
      const holds = new Map<string, () => void>();
      const gates = new Map<string, Promise<void>>();
      for (const title of ['From the head', 'From the tree']) gates.set(title, new Promise<void>((resolve) => holds.set(title, resolve)));
      const record = () => ({ id: 'a', urlId: 'a', collectionId: 'c1', title: serverTitle, parentId: null, myPermission: 'read-write' });
      const answer = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
      const api = {
        GET: async (path: string) => (path === '/v1/pages/by-url-id/{urlId}' ? answer(record()) : answer({ pages: SERVER.pages.map((p) => (p.id === 'a' ? { ...p, title: serverTitle } : p)) })),
        PATCH: async (_path: string, init: { body: { title: string } }) => {
          await gates.get(init.body.title);
          if (options.refuse) return { error: { error: { code: 'invalid' } }, response: new Response(null, { status: 422 }) };
          serverTitle = init.body.title;
          return answer({});
        },
      } as unknown as ApiLike;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const session = { auth: {}, api, collabUrl: 'ws://x', apiUrl: 'http://x' } as unknown as Session;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <SessionContext.Provider value={session}>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </SessionContext.Provider>
      );
      // The page screen reads the record; its head and the tree each have their own actions, over the same client.
      const open = renderHook(() => ({ page: usePage('a'), tree: useCollectionTree(api, 'c1') }), { wrapper });
      const head = renderHook(() => useTreeActions(api, 'c1'), { wrapper });
      const tree = renderHook(() => useTreeActions(api, 'c1'), { wrapper });
      const shown = () => (open.result.current.page.data?.kind === 'found' ? open.result.current.page.data.page.title : undefined);
      return { open, head, tree, shown, release: (title: string) => holds.get(title)?.(), server: () => serverTitle, client };
    };

    it.each([
      ['the head answered first, the tree last', ['From the head', 'From the tree'], 'From the tree'],
      ['the tree answered first, the head last', ['From the tree', 'From the head'], 'From the head'],
    ])('ends with the page record, the open page and the tree all on the server title (%s)', async (_name, order, finalTitle) => {
      const t = race();
      await waitFor(() => expect(t.shown()).toBe('Start'));
      await waitFor(() => expect(t.open.result.current.tree.data).toBeDefined());
      await act(async () => {
        const fromHead = t.head.result.current.rename('a', 'From the head');
        const fromTree = t.tree.result.current.rename('a', 'From the tree');
        // Each answer is let in only after the one before it has been handled: the PATCH of the one released is awaited through its own rename, not guessed with a pause.
        const done: Record<string, Promise<unknown>> = { 'From the head': fromHead, 'From the tree': fromTree };
        for (const title of order) {
          t.release(title);
          await done[title];
        }
      });
      expect(t.server()).toBe(finalTitle);
      await waitFor(() => expect(t.shown()).toBe(finalTitle)); // what the open page draws from
      const inTree = (t.client.getQueryData<readonly FlatPage[]>(treeKey('c1')) ?? []).find((p) => p.id === 'a')?.title;
      expect(inTree).toBe(finalTitle);
    });

    it('shows the new title at once, before any answer, and keeps it when the server accepts it', async () => {
      const t = race();
      await waitFor(() => expect(t.shown()).toBe('Start'));
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => { pending = t.head.result.current.rename('a', 'From the head'); });
      await waitFor(() => expect(t.shown(), 'at once').toBe('From the head'));
      await act(async () => { t.release('From the head'); await pending; });
      await waitFor(() => expect(t.shown()).toBe('From the head'));
    });

    it('rolls the shown title back when the server refuses the rename: the page record and the tree end on the title they had, and the outcome says it was refused', async () => {
      const t = race({ refuse: true });
      await waitFor(() => expect(t.shown()).toBe('Start'));
      await waitFor(() => expect(t.open.result.current.tree.data).toBeDefined());
      let pending: Promise<{ ok: boolean }> = Promise.resolve({ ok: true });
      await act(async () => { pending = t.head.result.current.rename('a', 'From the head'); });
      await waitFor(() => expect(t.shown(), 'at once').toBe('From the head'));
      let outcome: { ok: boolean } = { ok: true };
      await act(async () => { t.release('From the head'); outcome = await pending; });
      expect(outcome.ok).toBe(false);
      await waitFor(() => expect(t.shown()).toBe('Start'));
      await waitFor(() => expect((t.client.getQueryData<readonly FlatPage[]>(treeKey('c1')) ?? []).find((p) => p.id === 'a')?.title).toBe('Start'));
    });
  });
});
