import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../src/auth/session';
import Screen from '../../src/screens/admin';
import '../support/dom';
import { fakeApi, ok, user } from './support';

describe('the /admin routes', () => {
  it('show the users to an administrator, read through the API of the session', async () => {
    const { api, of } = fakeApi({ 'GET /v1/me': ok({ id: 'u1', name: 'Alice', email: 'a@dev.invalid', role: 'admin' }), 'GET /v1/users': ok({ items: [user('u1', 'Alice', 'admin')], nextCursor: null }) });
    render(
      <SessionContext.Provider value={{ auth: null as never, api }}>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/admin/users']}>
            <Routes>
              <Route path="/admin/users" element={<Screen />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeTruthy();
    expect(of('GET', '/v1/users')).toHaveLength(1);
  });
});
