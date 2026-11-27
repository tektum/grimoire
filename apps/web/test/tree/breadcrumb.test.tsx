import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routeObjects } from '../../src/app/router';
import { SessionContext } from '../../src/auth/session';
import '../support/dom';
import { COLLECTIONS, fakeApi, page } from './support';

const ok = (body: unknown) => ({ status: 200, body });

function open(path: string) {
  const { api } = fakeApi({
    'GET /v1/collections': ok({ items: COLLECTIONS }),
    'GET /v1/collections/{id}/tree': ok({ pages: [page('top', null, 'p1', 'Team handbook'), page('mid', 'top', 'p1', 'On-call'), page('leaf', 'mid', 'p1', 'Paging rules')] }),
    'GET /v1/pages/by-url-id/{urlId}': ok({ id: 'leaf', urlId: 'leaf', collectionId: 'c1', title: 'Paging rules' }),
  });
  render(
    <SessionContext.Provider value={{ auth: null as never, api, collabUrl: 'ws://collab.test' }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: [path] })} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}

describe('the top bar', () => {
  it('names the collection and the pages above the open page, the page itself last and not a link', async () => {
    open('/p/paging-rules-leaf');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => { expect(trail.textContent).toBe('DevTeam handbookOn-callPaging rules'); });
    expect(within(trail).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dev', 'Team handbook', 'On-call']);
    expect(within(trail).getByText('Paging rules').getAttribute('aria-current')).toBe('page');
  });

  it('shows only the collection on its own screen', async () => {
    open('/c/c1');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.textContent).toBe('Dev');
    expect(within(trail).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('the contents panel search button', () => {
  it('opens the palette', async () => {
    open('/c/c1');
    const contents = screen.getByRole('complementary', { name: 'Contents' });
    await userEvent.click(within(contents).getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('the contents button (phone)', () => {
  it('opens and closes the contents area, and says which it will do', async () => {
    open('/c/c1');
    const contents = screen.getByRole('complementary', { name: 'Contents' });
    const toggle = screen.getByRole('button', { name: 'Show contents' });
    expect(toggle.getAttribute('aria-controls')).toBe(contents.id);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide contents' }).getAttribute('aria-expanded')).toBe('true');
    expect(contents.hasAttribute('data-open')).toBe(true);
  });
});
