import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, type RouteObject, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);
import { ErrorBoundary } from '../../src/app/ErrorBoundary';
import { routeObjects } from '../../src/app/router';
import { ROUTES } from '../../src/app/routes';

describe('shell and screens', () => {
  it.each([
    ['/login', 'Sign-in'],
    ['/c/c1', 'Collection'],
    ['/p/a-b1', 'Page'],
    ['/p/a-b1/history', 'History'],
    ['/p/a-b1/history/r1', 'History'],
    ['/search', 'Search'],
    ['/trash', 'Trash'],
    ['/import', 'Import'],
    ['/admin/users', 'Admin'],
    ['/admin/groups', 'Admin'],
    ['/admin/collections/c1/access', 'Admin'],
    ['/nope/x', 'Page not found'],
  ])('renders %s inside the shell', async (url, heading) => {
    render(<RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: [url] })} />);
    expect((await screen.findAllByRole('heading', { level: 1 }))[0]?.textContent).toBe(heading);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByLabelText('Contents')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });
  it('has a screen for every row of the route table', () => {
    expect(routeObjects()[0]?.children?.length).toBe(ROUTES.length + 1);
  });
});

describe('ErrorBoundary', () => {
  it('shows an alert, logs only the error name, and recovers on Try again', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let boom = true;
    const Bad = () => {
      if (boom) throw new TypeError('secret document text');
      return <p>fine</p>;
    };
    render(
      <ErrorBoundary>
        <Bad />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    const logged = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('web.render_error'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('TypeError');
    expect(logged[0]).not.toContain('secret');
    boom = false;
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByText('fine')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('Shell error boundary', () => {
  it('clears the error alert when the user navigates to another route', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Bad = () => {
      throw new TypeError('x');
    };
    const routes = routeObjects();
    const children = routes[0]!.children!;
    const withBoom: RouteObject = { path: '/', element: routes[0]!.element, children: [{ path: '/boom', element: <Bad /> }, ...children] };
    const router = createMemoryRouter([withBoom], { initialEntries: ['/boom'] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    screen.getByRole('link', { name: 'Trash' }).click();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((await screen.findAllByRole('heading', { level: 1 }))[0]?.textContent).toBe('Trash');
    spy.mockRestore();
  });
});

describe('skip link', () => {
  it('never becomes a protocol-relative URL, whatever the path starts with', async () => {
    render(<RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: ['//evil.example/x'] })} />);
    const href = screen.getByRole('link', { name: 'Skip to the page' }).getAttribute('href')!;
    expect(href.startsWith('//')).toBe(false);
    expect(href.endsWith('#main')).toBe(true);
    await screen.findAllByRole('heading', { level: 1 });
  });

  it('points into the current page, not at the root of the document base', async () => {
    render(<RouterProvider router={createMemoryRouter(routeObjects(), { initialEntries: ['/p/a-b1/history?x=1'] })} />);
    const link = screen.getByRole('link', { name: 'Skip to the page' });
    expect(link.getAttribute('href')).toBe('/p/a-b1/history?x=1#main');
    expect(document.getElementById('main')).toBeTruthy();
    await screen.findAllByRole('heading', { level: 1 });
  });
});
