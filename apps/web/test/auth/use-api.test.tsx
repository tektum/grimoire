import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApi } from '../../src/api/context';
import { useApiQuery } from '../../src/api/query';
import { createAuth } from '../../src/auth';
import { SessionContext } from '../../src/auth/session';
import { config, fakeSdkStorage, fakeStorage } from './support';

afterEach(cleanup);

function Name() {
  const me = useApiQuery<{ name: string }>(useApi(), '/v1/me');
  return <p>{me.data?.name ?? 'loading'}</p>;
}

describe('useApi', () => {
  it('gives a screen the client of the session: a query through it answers, with the fake fetch under it', async () => {
    const GET = vi.fn(async () => ({ data: { name: 'alice' }, response: new Response('{}', { status: 200 }) }));
    const api = { GET, POST: vi.fn(), PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() };
    const auth = createAuth({ config: config(), storage: fakeStorage().storage, devSignIn: null, sdkStorage: fakeSdkStorage(), loadDescope: async () => Promise.reject(new Error('unused')) });
    render(
      <SessionContext.Provider value={{ auth, api: api as never, collabUrl: 'ws://collab.test' }}>
        <QueryClientProvider client={new QueryClient()}>
          <Name />
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(GET).toHaveBeenCalledWith('/v1/me', expect.anything());
  });

  it('says what is missing, instead of failing later, when there is no session around the screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Name />)).toThrow('useApi needs the session of the app');
  });
});
