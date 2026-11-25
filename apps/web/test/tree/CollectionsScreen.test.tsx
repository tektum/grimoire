import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CollectionsScreen } from '../../src/screens/collections/CollectionsScreen';
import '../support/dom';
import { COLLECTIONS, fakeApi, renderAt } from './support';

const ok = (body: unknown) => ({ status: 200, body });

describe('CollectionsScreen', () => {
  it('lists the collections the caller can read and marks the open one', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': ok(COLLECTIONS[0]) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    const nav = await screen.findByRole('navigation', { name: 'Collections' });
    expect((await within(nav).findAllByRole('link')).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['Dev', '/c/c1', 'page'],
      ['🔒Private', '/c/c2', null],
    ]);
  });

  it('names the open collection and points to the contents for its pages', async () => {
    const { api, calls } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': ok(COLLECTIONS[0]) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dev' })).toBeTruthy();
    expect(await screen.findByText('Choose a page in the contents, or start a new one.')).toBeTruthy();
    expect(calls).toContain('GET /v1/collections/{id} c1');
  });

  it.each([['admin', 1], ['member', 0], ['viewer', 0]] as const)('offers Manage access to an administrator only (%s)', async (role, count) => {
    const { api } = fakeApi({ 'GET /v1/me': ok({ id: 'u1', name: 'A', email: 'a@dev.invalid', role }), 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': ok(COLLECTIONS[0]) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    await screen.findByRole('heading', { level: 1, name: 'Dev' });
    await screen.findByText('Choose a page in the contents, or start a new one.');
    const links = screen.queryAllByRole('link', { name: 'Manage access' });
    expect(links).toHaveLength(count);
    if (count > 0) expect(links[0]?.getAttribute('href')).toBe('/admin/collections/c1/access');
  });

  it('shows the not-found screen for a collection the caller cannot read, the same for an unknown one', async () => {
    for (const status of [404, 403]) {
      const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': { status } });
      const view = renderAt(<CollectionsScreen api={api} collectionId="c9" />);
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
      view.unmount();
    }
  });

  it('offers to try again when the pages cannot be loaded, and goes on when they load', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': () => (attempt++ === 0 ? { status: 503 } : ok(COLLECTIONS[0])) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Choose a page in the contents, or start a new one.')).toBeTruthy();
  });

  it('says so when the caller can read no collection', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': ok({ items: [] }), 'GET /v1/collections/{id}': { status: 404 } });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByText('No collections yet')).toBeTruthy();
  });

  it('offers an administrator New collection beside the list of collections, and nobody else', async () => {
    for (const [role, shown] of [['admin', true], ['member', false]] as const) {
      const { api } = fakeApi({ 'GET /v1/collections': ok({ items: COLLECTIONS }), 'GET /v1/collections/{id}': ok(COLLECTIONS[0]), 'GET /v1/me': ok({ role }) });
      const view = renderAt(<CollectionsScreen api={api} collectionId="c1" />);
      await screen.findByText('Choose a page in the contents, or start a new one.');
      await waitFor(() => expect(screen.queryAllByRole('link', { name: 'New collection' }).length).toBe(shown ? 1 : 0));
      if (shown) expect(screen.getByRole('link', { name: 'New collection' }).getAttribute('href')).toBe('/collections/new');
      view.unmount();
    }
  });

  it('says so when the collection list cannot be loaded, and still shows the collection', async () => {
    const { api } = fakeApi({ 'GET /v1/collections': { status: 503 }, 'GET /v1/collections/{id}': ok(COLLECTIONS[0]) });
    renderAt(<CollectionsScreen api={api} collectionId="c1" />);
    expect(await screen.findByText("Couldn't load the collections.")).toBeTruthy();
    expect(await screen.findByText('Choose a page in the contents, or start a new one.')).toBeTruthy();
  });
});
