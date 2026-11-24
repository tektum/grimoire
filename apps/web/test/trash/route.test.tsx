import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../src/auth/session';
import Screen from '../../src/screens/trash';
import '../support/dom';
import { COLLECTIONS, fakeApi } from '../tree/support';

describe('the /trash route', () => {
  it('shows the trash read through the API of the session', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/collections': { status: 200, body: { items: COLLECTIONS } },
      'GET /v1/trash': { status: 200, body: { items: [{ id: 'a', title: 'Plan for May', collectionId: 'c1', deletedAt: 1, deletedBy: null, daysLeft: 3 }], nextCursor: null } },
    });
    render(
      <SessionContext.Provider value={{ auth: null as never, api, collabUrl: 'ws://collab.test' }}>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/trash']}>
            <Routes>
              <Route path="/trash" element={<Screen />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    expect(await screen.findByText('Plan for May')).toBeTruthy();
    expect(calls).toContain('GET /v1/trash');
  });
});
