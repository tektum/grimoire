import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../../src/auth';
import { SessionContext, type Session as AppSession } from '../../src/auth/session';
import PageScreen from '../../src/screens/page';

afterEach(cleanup);

/** Opens `/p/<slug>`; the API answers the same 404 for the page of someone else's private collection and for an id nobody has (R11.15). */
function open(slug: string) {
  const GET = vi.fn(async () => ({ data: { error: { code: 'not_found', message: 'Not found' } }, response: new Response('', { status: 404 }) }));
  const value: AppSession = { auth: {} as Auth, api: { GET } as unknown as AppSession['api'], collabUrl: 'ws://collab.test' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/p/:slug', element: <PageScreen /> }], { initialEntries: [`/p/${slug}`] });
  const view = render(
    <SessionContext.Provider value={value}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { GET, view };
}

describe('a page the person may not read looks the same as a page that does not exist', () => {
  it('shows the same words and the same markup, and nothing of the page', async () => {
    const forbidden = open('private-plan-aaa111');
    await screen.findByRole('heading', { name: 'Page not found' });
    const forbiddenHtml = forbidden.view.container.innerHTML;
    forbidden.view.unmount();
    const unknown = open('no-such-page-bbb222');
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(unknown.view.container.innerHTML).toBe(forbiddenHtml);
    expect(screen.getByText('This page does not exist, or you do not have access to it.')).toBeTruthy();
    expect(forbiddenHtml).not.toMatch(/private|plan|aaa111|no-such|bbb222/i);
    expect(forbidden.GET).toHaveBeenCalledTimes(1);
    expect(unknown.GET).toHaveBeenCalledTimes(1);
  });

  it('shows the same screen for a 403 as for a 404', async () => {
    const GET = vi.fn(async () => ({ data: {}, response: new Response('', { status: 403 }) }));
    const value: AppSession = { auth: {} as Auth, api: { GET } as unknown as AppSession['api'], collabUrl: 'ws://collab.test' };
    const router = createMemoryRouter([{ path: '/p/:slug', element: <PageScreen /> }], { initialEntries: ['/p/x-ccc333'] });
    render(
      <SessionContext.Provider value={value}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});
