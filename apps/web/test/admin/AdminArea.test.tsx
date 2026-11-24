import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminArea } from '../../src/screens/admin/AdminArea';
import '../support/dom';
import { fakeApi, ok, renderAt, user } from './support';

const me = (role: string) => ok({ id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role });
const show = (api: ReturnType<typeof fakeApi>['api'], path: string) =>
  renderAt(<Routes><Route path="/admin/*" element={<AdminArea api={api} />} /></Routes>, path);

describe('the admin area', () => {
  it('shows an administrator the users', async () => {
    const { api } = fakeApi({ 'GET /v1/me': me('admin'), 'GET /v1/users': ok({ items: [user('u1', 'Alice', 'admin')], nextCursor: null }) });
    show(api, '/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeTruthy();
  });

  it.each(['member', 'viewer'])('shows a %s the not-found screen, and makes no admin request', async (role) => {
    const { api, requests } = fakeApi({ 'GET /v1/me': me(role), 'GET /v1/users': ok({ items: [], nextCursor: null }) });
    show(api, '/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/me']);
  });

  it('shows the not-found screen for an admin address that is not a screen', async () => {
    const { api } = fakeApi({ 'GET /v1/me': me('admin') });
    show(api, '/admin/nothing');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it('asks nothing of the admin routes while it does not know who is signed in', () => {
    const { api, requests } = fakeApi({ 'GET /v1/me': me('admin') });
    show(api, '/admin/users');
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(requests.filter((r) => r.path !== '/v1/me')).toEqual([]);
  });

  it('offers to try again when it cannot tell who is signed in', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/me': () => (attempt++ === 0 ? { status: 503 } : me('member')) });
    show(api, '/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });
});
