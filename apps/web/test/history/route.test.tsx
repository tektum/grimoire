import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { Auth } from '../../src/auth';
import { SessionContext, type Session as AppSession } from '../../src/auth/session';
import HistoryScreen from '../../src/screens/history';
import '../support/dom';
import { queryKey } from '../../src/api/query';
import { fakeApi, ok, PAGE, rev } from './support';

afterEach(cleanup);

const BY_URL = 'GET /v1/pages/by-url-id/{urlId}';
function open(path: string, routes: Parameters<typeof fakeApi>[0], client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const { api, of } = fakeApi(routes);
  const session: AppSession = { auth: {} as Auth, api, collabUrl: 'ws://collab.test' };
  const router = createMemoryRouter([{ path: '/p/:slug/history', element: <HistoryScreen /> }, { path: '/p/:slug/history/:revisionId', element: <HistoryScreen /> }], { initialEntries: [path] });
  render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { of };
}

describe('the history routes', () => {
  it('asks for the page by the id at the end of the address, then lists its versions', async () => {
    const { of } = open('/p/quarterly-plan-abc123/history', { [BY_URL]: ok(PAGE), 'GET /v1/pages/{id}/revisions': ok({ items: [rev('r1')], nextCursor: null }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'History of Quarterly plan' })).toBeTruthy();
    expect(of('GET', '/v1/pages/by-url-id/{urlId}')[0]?.params.path).toEqual({ urlId: 'abc123' });
    expect(of('GET', '/v1/pages/{id}/revisions')[0]?.params.path).toEqual({ id: 'p1' });
  });

  it('calls a page with no title Untitled, in the heading and the way back', async () => {
    open('/p/untitled-abc123/history', { [BY_URL]: ok({ ...PAGE, title: '' }), 'GET /v1/pages/{id}/revisions': ok({ items: [rev('r1')], nextCursor: null }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'History of Untitled' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Untitled' })).toBeTruthy();
  });

  it('opens one version at /history/:revisionId', async () => {
    const { of } = open('/p/quarterly-plan-abc123/history/r7', { [BY_URL]: ok(PAGE), 'GET /v1/pages/{id}/revisions/{rid}': ok({ ...rev('r7'), markdown: '# x' }), 'GET /v1/pages/{id}/markdown': ok('# y') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Quarterly plan' })).toBeTruthy();
    expect(of('GET', '/v1/pages/{id}/revisions/{rid}')[0]?.params.path).toEqual({ id: 'p1', rid: 'r7' });
  });

  it('shows the not-found screen for a page that is not there or may not be read, and makes no history request', async () => {
    const { of } = open('/p/quarterly-plan-abc123/history', { [BY_URL]: { status: 404 } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(of('GET', '/v1/pages/{id}/revisions')).toHaveLength(0);
  });

  it('says the page cannot be opened right now, not that it is missing, when a page cached as missing fails to be read again', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKey('GET', '/v1/pages/by-url-id/{urlId}', { urlId: 'abc123' }), { kind: 'missing' });
    open('/p/quarterly-plan-abc123/history', { [BY_URL]: { status: 503 } }, client);
    expect((await screen.findByRole('alert')).textContent).toContain("can’t be opened right now");
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
  });

  it('says the page cannot be opened right now when its read fails', async () => {
    open('/p/quarterly-plan-abc123/history', { [BY_URL]: { status: 503 } });
    expect((await screen.findByRole('alert')).textContent).toContain("can’t be opened right now");
  });
});
