import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../src/auth/session';
import Screen from '../../src/screens/collections';
import '../support/dom';
import { COLLECTIONS, fakeApi } from './support';

describe('the /c/:collectionId route', () => {
  it('shows the collection named in the address, read through the API of the session', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/collections': { status: 200, body: { items: COLLECTIONS } },
      'GET /v1/collections/{id}': { status: 200, body: COLLECTIONS[1] },
    });
    render(
      <SessionContext.Provider value={{ auth: null as never, api }}>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/c/c2']}>
            <Routes>
              <Route path="/c/:collectionId" element={<Screen />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Private' })).toBeTruthy();
    expect(calls).toContain('GET /v1/collections/{id} c2');
  });
});
