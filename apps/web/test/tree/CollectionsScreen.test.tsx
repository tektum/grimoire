import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CollectionsScreen } from '../../src/screens/collections/CollectionsScreen';
import '../support/dom';
import { COLLECTIONS, fakeApi, page, renderAt } from './support';

const TREE = { pages: [page('welcome', null, 'p1', 'Welcome'), page('nested', 'welcome', 'p1', 'Nested')] };
const ok = (body: unknown) => ({ status: 200, body });

describe('CollectionsScreen', () => {
  it('lists the collections the caller can read and marks the open one', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': ok(TREE) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    const nav = await screen.findByRole('navigation', { name: 'Collections' });
    expect((await within(nav).findAllByRole('link')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['Dev', '/c/c1', 'page'],
      ['🔒Private', '/c/c2', null],
    ]);
  });

  it('shows the contents tree of the open collection under its name', async () => {
    const { api, calls } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': ok(TREE) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dev' })).toBeTruthy();
    await waitFor(() => { expect(screen.getAllByRole('treeitem').map((r) => within(r).getByRole('link').textContent)).toEqual(['Welcome', 'Nested']); });
    expect(calls).toContain('GET /v1/collections/{id}/tree c1');
  });

  it('shows the not-found screen for a collection the caller cannot read, the same for an unknown one', async () => {
    for (const status of [404, 403]) {
      const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': { status } });
      const view = renderAt(<CollectionsScreen api={api} collectionId="c9" />);
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
      view.unmount();
    }
  });

  it('offers to try again when the tree cannot be loaded, and loads it on the second try', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': () => (attempt++ === 0 ? { status: 503 } : ok(TREE)) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(screen.getAllByRole('treeitem')).toHaveLength(2); });
  });

  it('says so when the caller can read no collection', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: [] }), 'GET /v1/collections/{id}/tree': { status: 404 } });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByText('No collections yet')).toBeTruthy();
  });

  it('says so when the collection list cannot be loaded, and still shows the tree', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': { status: 503 }, 'GET /v1/collections/{id}/tree': ok(TREE) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByText("Couldn't load the collections.")).toBeTruthy();
    await waitFor(() => { expect(screen.getAllByRole('treeitem')).toHaveLength(2); });
  });

  it('keeps the tree it has when a later read fails, instead of replacing it with an error', async () => {
    let reads = 0;
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}/tree': () => (reads++ === 0 ? ok(TREE) : { status: 503 }) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    await waitFor(() => { expect(screen.getAllByRole('treeitem')).toHaveLength(2); });
    fireEvent.focus(window);
    await waitFor(() => { expect(reads).toBe(2); });
    await expect(screen.findByRole('alert', {}, { timeout: 200 })).rejects.toThrow(); // no error replaces the tree
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });

  it('offers New page and the row menus in a collection the caller can write in, and neither in one they can only read', async () => {
    const { api, bodies } = fakeApi({
      'GET /v1/collections': ok({ items: COLLECTIONS }),
      'GET /v1/collections/{id}/tree': ok(TREE),
      'POST /v1/pages': { status: 201, body: page('n', null, 'p9', '') },
    });
    const writable = renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'New page' }));
    await waitFor(() => { expect(bodies).toEqual([{ method: 'POST', path: '/v1/pages', body: { collectionId: 'c1', parentId: null } }]); });
    expect(screen.getAllByRole('button', { name: /Actions for/ }).length).toBeGreaterThan(0);
    writable.unmount();
    renderAt(<CollectionsScreen api={api} collectionId="c2" />);
    await waitFor(() => { expect(screen.getAllByRole('treeitem')).toHaveLength(2); });
    expect(screen.queryByRole('button', { name: 'New page' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });
});
