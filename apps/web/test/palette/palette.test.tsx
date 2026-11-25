import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { SessionContext, type Session } from '../../src/auth/session';
import { Palette } from '../../src/palette/Palette';
import '../support/dom';

afterEach(cleanup);

const COLLECTIONS = [
  { id: 'c1', name: 'Dev', myPermission: 'read-write' },
  { id: 'c2', name: 'Handbook', myPermission: 'read-only' },
];
const TREE = [
  { id: 'p1', urlId: 'ab12cd', parentId: null, position: 'p1', title: 'Quarterly plan', icon: null },
  { id: 'p2', urlId: 'zz99', parentId: null, position: 'p2', title: 'Meeting notes', icon: null },
];
const HIT = (id: string, title: string, text: string, ranges: [number, number][]) => ({ pageId: id, urlId: `u${id}`, title, snippet: { text, ranges }, collectionId: 'c1', rank: 1, updatedAt: '2026-11-20T00:00:00Z' });

function fake(options: { role?: string; search?: (q: string) => { status: number; body?: unknown }; tree?: () => number } = {}) {
  const searches: string[] = [];
  const answer = (status: number, body?: unknown) => ({ data: status < 300 ? body : undefined, error: status < 300 ? undefined : body, response: new Response(null, { status }) });
  const api = {
    GET: async (path: string, init?: { params?: { query?: { q?: string } } }) => {
      if (path === '/v1/me') return answer(200, { id: 'u', name: 'Alice Archer', email: 'a@dev.invalid', role: options.role ?? 'member' });
      if (path === '/v1/collections') return answer(200, { items: COLLECTIONS });
      if (path === '/v1/collections/{id}/tree') {
        const status = options.tree?.() ?? 200;
        return answer(status, status < 300 ? { pages: TREE } : { error: { code: 'not_found' } });
      }
      if (path === '/v1/search') {
        const q = init?.params?.query?.q ?? '';
        searches.push(q);
        const result = (options.search ?? (() => ({ status: 200, body: { items: [], nextCursor: null } })))(q);
        return answer(result.status, result.body);
      }
      return answer(404);
    },
    POST: async () => answer(500),
    PUT: async () => answer(500),
    PATCH: async () => answer(500),
    DELETE: async () => answer(500),
  } as unknown as ApiLike;
  return { api, searches };
}

const Where = () => {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
};

function show(api: ApiLike, at = '/c/c1') {
  const session = { auth: {}, api, collabUrl: 'ws://x', apiUrl: 'http://x' } as unknown as Session;
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[at]}>
          <button type="button">before</button>
          <Palette />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}
const where = () => screen.getByTestId('where').textContent;
const openIt = async () => {
  await userEvent.keyboard('{Control>}k{/Control}');
  return screen.findByRole('combobox');
};

describe('the command palette', () => {
  it('opens with Mod-K (Ctrl or Cmd) with the focus in the input, and closes with it again', async () => {
    show(fake().api);
    const input = await openIt();
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('combobox')).toBeTruthy();
  });

  it('closes with Escape and gives the focus back to what had it', async () => {
    show(fake().api);
    screen.getByRole('button', { name: 'before' }).focus();
    await openIt();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }));
  });

  it('lists the pages of the open collection, the collections and the places, and filters them as the text is typed (no search for a text that is only a command)', async () => {
    const t = fake();
    show(t.api);
    await openIt();
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Quarterly plan', 'Meeting notes', 'Dev', 'Handbook', 'Search', 'Trash', 'New page']);
    await userEvent.keyboard('trash');
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Trash']));
  });

  it('offers Admin to an administrator only, and goes to a page of the collection on Enter', async () => {
    show(fake({ role: 'admin' }).api);
    await openIt();
    expect(await screen.findByRole('option', { name: 'Admin' })).toBeTruthy();
    await userEvent.keyboard('meeting{Enter}');
    await waitFor(() => expect(where()).toBe('/p/meeting-notes-zz99'));
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
  });

  it('drops the pages of the collection when a later read of its tree is refused (access removed, collection deleted): the last data is kept by the query, and not offered', async () => {
    let reads = 0;
    show(fake({ tree: () => (reads++ === 0 ? 200 : 404) }).api);
    await openIt();
    expect(await screen.findByRole('option', { name: 'Quarterly plan' })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Quarterly plan' })).toBeNull());
    expect(screen.queryByRole('option', { name: 'New page' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Trash' })).toBeTruthy(); // the places stay
  });

  it('does not offer New page in a collection the person can only read', async () => {
    show(fake().api, '/c/c2');
    await openIt();
    await screen.findByRole('option', { name: 'Trash' });
    expect(screen.queryByRole('option', { name: 'New page' })).toBeNull();
  });

  it('searches when the typing pauses, once, for the text typed, shows the results with the matched words in mark, and Enter opens the first result (not a command that was there before it)', async () => {
    const t = fake({
      search: (q) => ({
        status: 200,
        body: { items: [HIT('r1', 'Notes on the roadmap', 'the roadmap for the next quarter', [[4, 11]]), HIT('r2', 'Other', 'also roadmap', [[5, 12]])], nextCursor: null, semantic: false, q },
      }),
    });
    show(t.api);
    await openIt();
    await userEvent.keyboard('roadmap');
    const option = await screen.findByRole('option', { name: /Notes on the roadmap/ });
    expect(option.querySelector('mark')!.textContent).toBe('roadmap');
    expect(t.searches).toEqual(['roadmap']);
    await waitFor(() => expect(screen.getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(where()).toBe('/p/notes-on-the-roadmap-ur1'));
  });

  it('has a way to all the results: "See all results" opens the search screen with the text', async () => {
    const t = fake({ search: () => ({ status: 200, body: { items: [HIT('r1', 'A', 'x y', [[0, 1]])], nextCursor: null } }) });
    show(t.api);
    await openIt();
    await userEvent.keyboard('a & b');
    await userEvent.click(await screen.findByRole('option', { name: /See all results/ }));
    await waitFor(() => expect(where()).toBe('/search?q=a%20%26%20b'));
  });

  it('draws a result whose title and snippet are markup as text only', async () => {
    const t = fake({ search: () => ({ status: 200, body: { items: [HIT('r1', '<img src=x onerror=alert(1)>', '<script>alert(1)</script> hit', [[26, 29]])], nextCursor: null } }) });
    show(t.api);
    await openIt();
    await userEvent.keyboard('hit');
    const option = await screen.findByRole('option', { name: /img src/ });
    expect(option.querySelector('img, script')).toBeNull();
    expect(option.textContent).toContain('<script>alert(1)</script> hit');
  });

  it('says so when the search fails, and shows "No results" when nothing matches at all', async () => {
    const failing = fake({ search: () => ({ status: 503, body: { error: { code: 'unavailable' } } }) });
    show(failing.api);
    await openIt();
    await userEvent.keyboard('quarterly');
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Search is not available right now.');
    await userEvent.keyboard('zzzzzz');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    cleanup();
    show(fake().api);
    await openIt();
    await userEvent.keyboard('zzzz');
    expect((await screen.findByText('No results')).textContent).toBe('No results');
  });

  it('asks nothing for a text of only spaces, and puts the text away when it closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = fake();
      show(t.api);
      await openIt();
      await userEvent.keyboard('   ');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      }); // the typing pause is over
      expect(t.searches).toEqual([]);
      await userEvent.keyboard('x{Escape}');
      await openIt();
      expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
