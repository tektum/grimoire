import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routeObjects } from '../../src/app/router';
import { SessionContext } from '../../src/auth/session';
import '../support/dom';
import { COLLECTIONS, fakeApi, page } from './support';

const ok = (body: unknown) => ({ status: 200, body });

describe('the contents area of the shell', () => {
  it('holds the tree of the open collection beside the screen, once there is a session', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': ok({ pages: [page('welcome', null, 'p1', 'Welcome'), page('nested', 'welcome', 'p1', 'Nested')] }) });
    render(
      <SessionContext.Provider value={{ auth: null as never, api }}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: ['/c/c1'] })} />
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    const contents = screen.getByRole('complementary', { name: 'Contents' });
    await waitFor(() => { expect(within(contents).getAllByRole('treeitem')).toHaveLength(2); });
    expect(within(screen.getByRole('main')).queryByRole('tree')).toBeNull(); // the screen itself holds no second tree
  });

  it('says only "Contents" without a session (a screen under test on its own)', () => {
    render(<RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: ['/search'] })} />);
    const contents = screen.getByRole('complementary', { name: 'Contents' });
    expect(contents.textContent).toBe('Contents');
  });
});
