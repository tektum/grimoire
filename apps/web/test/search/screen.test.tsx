import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { SessionContext, type Session } from '../../src/auth/session';
import SearchScreen, { PARTIAL_TEXT } from '../../src/screens/search';
import '../support/dom';

afterEach(cleanup);

const hit = (id: string, title: string, text: string, ranges: [number, number][] = [], extra: Record<string, unknown> = {}) => ({
  pageId: id,
  urlId: `u${id}`,
  title,
  snippet: { text, ranges },
  collectionId: 'c1',
  rank: 1,
  updatedAt: '2026-11-20T00:00:00Z',
  ...extra,
});

function fake(answer: (q: string, cursor: string | null) => { status?: number; items?: unknown[]; nextCursor?: string | null }) {
  const requests: { q: string; cursor: string | null; limit: number | undefined }[] = [];
  const api = {
    GET: async (_path: string, init: { params: { query: { q: string; cursor?: string; limit?: number } } }) => {
      const { q, cursor = null, limit } = init.params.query;
      requests.push({ q, cursor, limit });
      const result = answer(q, cursor);
      const status = result.status ?? 200;
      return {
        data: status < 300 ? { items: result.items ?? [], nextCursor: result.nextCursor ?? null } : undefined,
        error: status < 300 ? undefined : { error: { code: 'unavailable' } },
        response: new Response(null, { status }),
      };
    },
  } as unknown as ApiLike;
  return { api, requests };
}

const Where = () => {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
};
function show(api: ApiLike, at: string) {
  const session = { auth: {}, api, collabUrl: 'ws://x', apiUrl: 'http://x' } as unknown as Session;
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route
              path="/search"
              element={
                <>
                  <SearchScreen />
                  <Where />
                </>
              }
            />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}

describe('the search screen', () => {
  it('asks for nothing and says what to do when there is no query, and for a query that is too long says so', async () => {
    const t = fake(() => ({}));
    show(t.api, '/search');
    expect(screen.getByText('Type what to look for, and press Enter.')).toBeTruthy();
    cleanup();
    show(t.api, `/search?q=${'x'.repeat(201)}`);
    expect(screen.getByText('Search takes at most 200 characters.')).toBeTruthy();
    expect(t.requests).toEqual([]);
  });

  it('reads the query from the address, shows the results as links to the pages with the snippet in mark, and a result without a passage has no extra line', async () => {
    const t = fake(() => ({ items: [hit('1', 'Product plan', 'the roadmap for the quarter', [[4, 11]]), hit('2', '', 'nothing marked')] }));
    show(t.api, '/search?q=roadmap');
    const list = await screen.findByRole('list', { name: 'Results for roadmap' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'Product plan' }).getAttribute('href')).toBe('/p/product-plan-u1');
    expect(rows[0]!.querySelector('mark')!.textContent).toBe('roadmap');
    expect(within(rows[1]!).getByRole('link', { name: 'Untitled' }).getAttribute('href')).toBe('/p/page-u2');
    expect(rows[1]!.querySelectorAll('p')).toHaveLength(1); // the snippet only
    expect(t.requests).toEqual([{ q: 'roadmap', cursor: null, limit: 20 }]);
  });

  it('shows the matched passage as plain text under the snippet, whatever it holds, and nothing runs', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    const passage = '<img src=x onerror=alert(1)>';
    const t = fake(() => ({ items: [hit('1', 'A', 'a snippet', [[0, 1]], { matchedPassage: { text: passage } })] }));
    show(t.api, '/search?q=a');
    const row = (await screen.findAllByRole('listitem'))[0]!;
    expect(row.querySelector('.search-passage')!.textContent).toBe(passage);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('mark')!.textContent).toBe('a'); // the snippet is kept
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('says only the beginning of a partly indexed page is searchable, and says it for that result only', async () => {
    const t = fake(() => ({ items: [hit('1', 'Big', 'x', [], { partial: true }), hit('2', 'Small', 'y')] }));
    show(t.api, '/search?q=x');
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]!).getByText(PARTIAL_TEXT)).toBeTruthy();
    expect(within(rows[1]!).queryByText(PARTIAL_TEXT)).toBeNull();
    expect(PARTIAL_TEXT).toBe('Only the beginning of this page is searchable');
  });

  it('shows "No results" for an empty list', async () => {
    show(fake(() => ({ items: [] })).api, '/search?q=nothing');
    expect((await screen.findByText('No results')).textContent).toBe('No results');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('paginates: "Show more results" makes a second request that carries the cursor, appends the page, and goes when there is no next cursor', async () => {
    const t = fake((_q, cursor) => (cursor === null ? { items: [hit('1', 'First', 'a')], nextCursor: 'CUR1' } : { items: [hit('2', 'Second', 'b')], nextCursor: null }));
    show(t.api, '/search?q=a');
    await userEvent.click(await screen.findByRole('button', { name: 'Show more results' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(t.requests.map((r) => r.cursor)).toEqual([null, 'CUR1']);
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['First', 'Second']);
    expect(screen.queryByRole('button', { name: 'Show more results' })).toBeNull();
  });

  it('says so when the search fails, and tries again on request', async () => {
    let fail = true;
    const t = fake(() => (fail ? { status: 503 } : { items: [hit('1', 'Back', 'a')] }));
    show(t.api, '/search?q=a');
    expect((await screen.findByRole('alert')).textContent).toContain('Search is not available right now.');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Back' })).toBeTruthy();
  });

  it('searches the typed text on Enter, by putting it in the address, and the field follows the address', async () => {
    const t = fake(() => ({ items: [] }));
    show(t.api, '/search');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search pages' }), '  quarterly plan {Enter}');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/search?q=quarterly+plan'));
    await screen.findByText('No results');
    expect(t.requests.map((r) => r.q)).toEqual(['quarterly plan']);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('quarterly plan');
  });
});
