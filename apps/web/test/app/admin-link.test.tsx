import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { AdminLink } from '../../src/app/AdminLink';
import { SessionContext, type Session } from '../../src/auth/session';
import '../support/dom';

afterEach(cleanup);

function show(role: 'admin' | 'member' | 'viewer' | null, status = 200) {
  const api = {
    GET: async () => ({ data: status < 300 ? { name: 'Ada', email: 'ada@example.test', role } : undefined, error: status < 300 ? undefined : {}, response: new Response(null, { status }) }),
  } as unknown as ApiLike;
  const session = role === undefined ? null : ({ auth: null, api, collabUrl: 'ws://collab.invalid' } as unknown as Session);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionContext.Provider value={session}>
        <MemoryRouter>
          <AdminLink />
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

describe('the Admin link of the header', () => {
  it('is there for an administrator and goes to the users of the workspace', async () => {
    show('admin');
    const link = await screen.findByRole('link', { name: 'Admin' });
    expect(link.getAttribute('href')).toBe('/admin/users');
  });

  it.each(['member', 'viewer'] as const)('is not there for a %s', async (role) => {
    show(role);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('is not there when the person is not known (the request failed): an admin link shown to nobody is better than one shown to everybody', async () => {
    show('admin', 500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });
});
