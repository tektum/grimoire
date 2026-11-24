import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { UserPicker } from '../../src/screens/admin/UserPicker';
import '../support/dom';
import { fakeApi, ok, user } from './support';

describe('the person finder', () => {
  it('retries the refetch, not the next page, when a background refetch of a finished search fails', async () => {
    let calls = 0;
    const { api, of } = fakeApi({ 'GET /v1/users': () => (++calls === 2 ? { status: 503 } : ok({ items: [user('u3', 'Carol')], nextCursor: null })) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <UserPicker api={api} label="Find" exclude={new Set()} actionLabel={(n) => `Add ${n}`} onPick={() => {}} />
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find' }), 'ca');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    await screen.findByRole('button', { name: 'Add Carol' });
    await client.invalidateQueries({ queryKey: ['GET', '/v1/users'] }); // a refetch in the background: it fails, the results stay
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Add Carol' })).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
    expect(of('GET', '/v1/users')).toHaveLength(3);
    expect(of('GET', '/v1/users').every((r) => (r.params.query as { cursor?: string }).cursor === undefined)).toBe(true);
  });
});
