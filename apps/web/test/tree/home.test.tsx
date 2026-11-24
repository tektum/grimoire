import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../src/auth/session';
import HomeScreen from '../../src/screens/collections/HomeScreen';
import { HomeRedirect } from '../../src/screens/collections/HomeRedirect';
import { CollectionsScreen } from '../../src/screens/collections/CollectionsScreen';
import { createClientStorage } from '../../src/storage';
import '../support/dom';
import { COLLECTIONS, fakeApi, page } from './support';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial).map(([k, v]) => [`grimoire.${k}`, v]));
  return createClientStorage({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } });
};
const Where = () => <output aria-label="location">{useLocation().pathname}</output>;
const at = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={ui} /><Route path="/c/:id" element={<Where />} /></Routes></MemoryRouter></QueryClientProvider>);
const list = (items: unknown[]) => ({ 'GET /v1/collections': { status: 200, body: { items } } });

describe('/ (HomeRedirect)', () => {
  it('goes to the collection that was read last', async () => {
    at(<HomeRedirect api={fakeApi(list(COLLECTIONS)).api} storage={memoryStorage({ 'last-collection': 'c2' })} />);
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/c/c2'); });
  });
  it('goes to the first collection when none was read, or the last one can no longer be read', async () => {
    for (const stored of [{}, { 'last-collection': 'gone' }]) {
      const view = at(<HomeRedirect api={fakeApi(list(COLLECTIONS)).api} storage={memoryStorage(stored)} />);
      await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/c/c1'); });
      view.unmount();
    }
  });
  it('says so when there is no collection to open', async () => {
    at(<HomeRedirect api={fakeApi(list([])).api} storage={memoryStorage()} />);
    expect(await screen.findByText('No collections yet')).toBeTruthy();
  });
  it('offers to try again when the collections cannot be loaded', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/collections': () => (attempt++ === 0 ? { status: 503 } : { status: 200, body: { items: COLLECTIONS } }) });
    at(<HomeRedirect api={api} storage={memoryStorage()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/c/c1'); });
  });
});

describe('the collection that was read last', () => {
  const routes = { ...list(COLLECTIONS), 'GET /v1/collections/{id}/tree': { status: 200, body: { pages: [page('w', null, 'p1', 'Welcome')] } } };
  it('is remembered once its tree has loaded', async () => {
    const storage = memoryStorage();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><CollectionsScreen api={fakeApi(routes).api} collectionId="c2" storage={storage} /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => { expect(storage.get('last-collection')).toBe('c2'); });
  });
  it('is not replaced by a collection that cannot be read', async () => {
    const storage = memoryStorage({ 'last-collection': 'c1' });
    const { api } = fakeApi({ ...list(COLLECTIONS), 'GET /v1/collections/{id}/tree': { status: 404 } });
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><CollectionsScreen api={api} collectionId="c9" storage={storage} /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(storage.get('last-collection')).toBe('c1');
  });
});

describe('the route /', () => {
  it('opens the collection that was read last, through the API of the session and the browser storage', async () => {
    localStorage.setItem('grimoire.last-collection', 'c2');
    const { api } = fakeApi(list(COLLECTIONS));
    at(<SessionContext.Provider value={{ auth: null as never, api }}><HomeScreen /></SessionContext.Provider>);
    await waitFor(() => { expect(screen.getByLabelText('location').textContent).toBe('/c/c2'); });
    localStorage.removeItem('grimoire.last-collection');
  });
});
