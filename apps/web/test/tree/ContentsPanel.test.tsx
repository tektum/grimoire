import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { createClientStorage } from '../../src/storage';
import { ContentsPanel } from '../../src/tree/ContentsPanel';
import '../support/dom';
import { COLLECTIONS, fakeApi, page } from './support';

const TREE = { pages: [page('welcome', null, 'p1', 'Welcome'), page('nested', 'welcome', 'p1', 'Nested')] };
const ok = (body: unknown) => ({ status: 200, body });
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial).map(([k, v]) => [`grimoire.${k}`, v]));
  return createClientStorage({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } });
};
const base = { 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': ok(TREE) };
const show = (api: ApiLike, path: string, storage = memoryStorage()) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<ContentsPanel api={api} storage={storage} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const titles = () => screen.getAllByRole('treeitem').map((r) => within(r).getByRole('link').textContent);

describe('the contents panel', () => {
  it('shows the tree of the collection in the address /c/:id, under the collection name', async () => {
    const { api, calls } = fakeApi(base);
    show(api, '/c/c1');
    await waitFor(() => { expect(titles()).toEqual(['Welcome', 'Nested']); });
    expect(screen.getByRole('link', { name: 'Dev' }).getAttribute('href')).toBe('/c/c1');
    expect(calls).toContain('GET /v1/collections/{id}/tree c1');
  });

  it('shows the tree of the collection of the page that is open, and marks that page', async () => {
    const { api, calls } = fakeApi({ ...base, 'GET /v1/pages/by-url-id/{urlId}': ok({ id: 'nested', urlId: 'nested', collectionId: 'c2', title: 'Nested' }) });
    show(api, '/p/nested-nested');
    await waitFor(() => { expect(titles()).toHaveLength(2); });
    expect(calls).toContain('GET /v1/pages/by-url-id/{urlId} nested');
    expect(calls).toContain('GET /v1/collections/{id}/tree c2');
    expect(screen.getByRole('link', { name: 'Nested' }).getAttribute('aria-current')).toBe('page');
  });

  it('follows the page screens of a page too (its history)', async () => {
    const { api, calls } = fakeApi({ ...base, 'GET /v1/pages/by-url-id/{urlId}': ok({ id: 'nested', urlId: 'nested', collectionId: 'c1', title: 'Nested' }) });
    show(api, '/p/nested-nested/history');
    await waitFor(() => { expect(titles()).toHaveLength(2); });
    expect(calls).toContain('GET /v1/pages/by-url-id/{urlId} nested');
  });

  it('shows the collection read last on a screen that belongs to no collection (/trash)', async () => {
    const { api, calls } = fakeApi(base);
    show(api, '/trash', memoryStorage({ 'last-collection': 'c2' }));
    await waitFor(() => { expect(titles()).toHaveLength(2); });
    expect(calls).toContain('GET /v1/collections/{id}/tree c2');
  });

  it('shows nothing but its name where there is no collection to show (no page open, nothing read last)', async () => {
    const { api, calls } = fakeApi(base);
    show(api, '/trash');
    expect(screen.getByText('Contents')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(calls.filter((c) => c.includes('/tree'))).toEqual([]);
  });

  it('shows nothing but its name for a page that cannot be read (the page screen says so)', async () => {
    const { api } = fakeApi({ ...base, 'GET /v1/pages/by-url-id/{urlId}': { status: 404 } });
    show(api, '/p/gone-0000');
    expect(await screen.findByText('Contents')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('shows nothing but its name for a collection that cannot be read', async () => {
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/tree': { status: 404 } });
    show(api, '/c/c9');
    expect(await screen.findByText('Contents')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByText('Loading')).toBeNull(); });
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('offers to try again when the tree cannot be loaded, and loads it on the second try', async () => {
    let attempt = 0;
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/tree': () => (attempt++ === 0 ? { status: 503 } : ok(TREE)) });
    show(api, '/c/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(titles()).toHaveLength(2); });
  });

  it('keeps the tree it has when a later read fails, instead of replacing it with an error', async () => {
    let reads = 0;
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/tree': () => (reads++ === 0 ? ok(TREE) : { status: 503 }) });
    show(api, '/c/c1');
    await waitFor(() => { expect(titles()).toHaveLength(2); });
    fireEvent.focus(window);
    await waitFor(() => { expect(reads).toBe(2); });
    await expect(screen.findByRole('alert', {}, { timeout: 200 })).rejects.toThrow();
    expect(titles()).toHaveLength(2);
  });

  it('offers New page and the row menus in a collection the caller can write in, and neither in one they can only read', async () => {
    const { api, bodies } = fakeApi({ ...base, 'POST /v1/pages': { status: 201, body: page('n', null, 'p9', '') } });
    const writable = show(api, '/c/c1');
    await userEvent.click(await screen.findByRole('button', { name: 'New page' }));
    await waitFor(() => { expect(bodies).toEqual([{ method: 'POST', path: '/v1/pages', body: { collectionId: 'c1', parentId: null } }]); });
    expect(screen.getAllByRole('button', { name: /Actions for/ }).length).toBeGreaterThan(0);
    writable.unmount();
    show(api, '/c/c2');
    await waitFor(() => { expect(titles()).toHaveLength(2); });
    expect(screen.queryByRole('button', { name: 'New page' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('says there is no page yet in an empty collection, and still offers New page', async () => {
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/tree': ok({ pages: [] }) });
    show(api, '/c/c1');
    expect(await screen.findByText('No pages yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New page' })).toBeTruthy();
  });
});
