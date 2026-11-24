import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../../src/auth';
import { SessionContext, type Session as AppSession } from '../../src/auth/session';
import PageScreen from '../../src/screens/page';

afterEach(cleanup);

const show = (status: number, body: unknown = {}) => {
  const GET = vi.fn(async () => ({ data: body, response: new Response('', { status }) }));
  const value: AppSession = { auth: {} as Auth, api: { GET } as unknown as AppSession['api'], collabUrl: 'ws://collab.test' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/p/:slug', element: <PageScreen /> }], { initialEntries: ['/p/my-plan-abc123'] });
  render(
    <SessionContext.Provider value={value}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { GET, client };
};

describe('the page screen asks for the page by the id at the end of its address', () => {
  it('asks by the text after the last dash', async () => {
    const { GET } = show(404);
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(GET).toHaveBeenCalledWith('/v1/pages/by-url-id/{urlId}', expect.objectContaining({ params: { path: { urlId: 'abc123' } } }));
  });

  it('a page that is not there and a page that may not be read look the same', async () => {
    show(403);
    expect(await screen.findByText('This page does not exist, or you do not have access to it.')).toBeTruthy();
  });

  it('says it cannot be opened when the server fails, and not that the page is missing', async () => {
    show(500);
    expect((await screen.findByRole('alert')).textContent).toMatch(/can.t be opened right now/);
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('shows the title of a page that was found (the editor itself is covered by the page view tests)', async () => {
    show(200, { id: '11111111-1111-4111-8111-111111111111', title: 'My plan', myPermission: 'read-write', markdownStale: false });
    expect((await screen.findByRole('heading', { name: 'My plan' })).tagName).toBe('H1');
    await waitFor(() => expect(screen.getByTestId('editor-root').getAttribute('data-collab-state')).toBe('connecting'));
  });

  it('keeps an open page open when the page cannot be read again: the editor and its unsent typing are not torn down', async () => {
    const { GET, client } = show(200, { id: '11111111-1111-4111-8111-111111111111', title: 'My plan', myPermission: 'read-write', markdownStale: false });
    await screen.findByRole('heading', { name: 'My plan' });
    GET.mockResolvedValue({ data: {}, response: new Response('', { status: 500 }) });
    await act(async () => void (await client.refetchQueries()));
    await waitFor(() => expect(client.getQueryCache().getAll()[0]!.state.status).toBe('error')); // the read failed ...
    await act(async () => undefined); // ... and the screen has had its turn to react
    expect(screen.getByRole('heading', { name: 'My plan' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
