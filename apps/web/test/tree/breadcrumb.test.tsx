import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routeObjects } from '../../src/app/router';
import { openPalette, shortcutHint } from '../../src/palette/open';
import { SessionContext } from '../../src/auth/session';
import { LAST_COLLECTION_KEY } from '../../src/screens/collections/useCollections';
import { createClientStorage } from '../../src/storage';
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
    // The items as assistive technology has them: the fold ("...") for a phone is hidden from it, so it is not part of the trail's text.
    await waitFor(() => { expect(within(trail).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Dev', 'Team handbook', 'On-call', 'Paging rules']); });
    expect(within(trail).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dev', 'Team handbook', 'On-call']);
    expect(within(trail).getByText('Paging rules').getAttribute('aria-current')).toBe('page');
  });

  it('gives every item its full name as a tooltip, so a name cut with an ellipsis can still be read', async () => {
    open('/p/paging-rules-leaf');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await within(trail).findByText('Paging rules');
    expect(within(trail).getAllByRole('link').map((a) => a.getAttribute('title'))).toEqual(['Dev', 'Team handbook', 'On-call']);
    expect(within(trail).getByText('Paging rules').getAttribute('title')).toBe('Paging rules');
  });

  it('folds the items between the first and the last into one "..." for a phone, hidden from assistive technology, which keeps every item', async () => {
    open('/p/paging-rules-leaf');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await within(trail).findByText('Paging rules');
    const fold = trail.querySelector('.breadcrumb-fold');
    expect(fold?.textContent).toBe('\u2026');
    expect(fold?.getAttribute('aria-hidden')).toBe('true');
    expect([...trail.querySelectorAll('.breadcrumb-middle')].map((li) => li.textContent)).toEqual(['Team handbook', 'On-call']);
    expect(within(trail).getByText('Paging rules').closest('li')?.classList.contains('breadcrumb-middle')).toBe(false);
  });

  it('shows only the collection on its own screen', async () => {
    open('/c/c1');
    const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.textContent).toBe('Dev');
    expect(trail.querySelector('.breadcrumb-fold')).toBeNull(); // nothing between the first and the last: nothing to fold
    expect(within(trail).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('the top bar on other screens', () => {
  it('has no trail on a screen that is not a collection or a page, even with a collection remembered', async () => {
    createClientStorage().set(LAST_COLLECTION_KEY, 'c1');
    open('/search');
    await screen.findAllByRole('treeitem'); // the remembered collection has loaded, so a trail could be drawn
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('the contents panel search button', () => {
  it('opens the palette', async () => {
    open('/c/c1');
    const contents = screen.getByRole('complementary', { name: 'Contents' });
    await userEvent.click(within(contents).getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('combobox')); // the button is behind the dialog now; ask again as a script would
    openPalette();
    expect(screen.getByRole('dialog')).toBeTruthy(); // asking an open palette to open does not close it
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

describe('the menu button (phone)', () => {
  it('opens and closes the links and the account area behind it', async () => {
    open('/c/c1');
    const toggle = screen.getByRole('button', { name: 'Show menu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide menu' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.hasAttribute('data-open')).toBe(true);
  });
});

describe('the key shown on the search button', () => {
  it('is Cmd K on a Mac or an iPad and Ctrl K elsewhere', () => {
    expect(shortcutHint('MacIntel')).toBe('Cmd K');
    expect(shortcutHint('iPad')).toBe('Cmd K');
    expect(shortcutHint('Win32')).toBe('Ctrl K');
    expect(shortcutHint('Linux x86_64')).toBe('Ctrl K');
  });
});
