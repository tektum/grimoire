import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { UsersScreen } from '../../src/screens/admin/UsersScreen';
import '../support/dom';
import { fakeApi, ok, renderAt, user } from './support';

const ALICE = user('u1', 'Alice', 'admin');
const BOB = user('u2', 'Bob', 'member');
const CAROL = user('u3', 'Carol', 'viewer', true);
const list = (items: unknown[], nextCursor: string | null = null) => ok({ items, nextCursor });
const rows = () => screen.getAllByRole('listitem');

describe('the users screen', () => {
  it('lists the users with their email, role and whether they are suspended', async () => {
    const { api } = fakeApi({ 'GET /v1/users': ok({ items: [ALICE, BOB, CAROL], nextCursor: null }) });
    renderAt(<UsersScreen api={api} />);
    await screen.findByText('Alice');
    expect(rows().map((r) => [within(r).getByRole('heading', { level: 2 }).textContent, within(r).getByText(/@dev\.invalid/).textContent])).toEqual([
      ['Alice', 'alice@dev.invalid'],
      ['Bob', 'bob@dev.invalid'],
      ['Carol', 'carol@dev.invalid'],
    ]);
    expect(rows().map((r) => within(r).queryByText('Suspended') !== null)).toEqual([false, false, true]);
    expect(rows().map((r) => within(r).getByRole('button').textContent)).toEqual(['Suspend', 'Suspend', 'Reinstate']);
    expect((within(rows()[2] as HTMLElement).getByLabelText('Role of Carol') as HTMLSelectElement).value).toBe('viewer');
  });

  it('searches by a word of a name or an email, sending it as q', async () => {
    const { api, of } = fakeApi({ 'GET /v1/users': (r) => list(r.params.query?.['q'] === 'bo' ? [BOB] : [ALICE, BOB]) });
    renderAt(<UsersScreen api={api} />);
    await screen.findByText('Alice');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search users' }), 'bo');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => { expect(rows()).toHaveLength(1); });
    expect(of('GET', '/v1/users').at(-1)?.params.query).toMatchObject({ q: 'bo' });
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('limits the search box to the 200 characters the server accepts, so no search is invalid', async () => {
    const { api } = fakeApi({ 'GET /v1/users': list([ALICE]) });
    renderAt(<UsersScreen api={api} />);
    expect((await screen.findByRole('searchbox', { name: 'Search users' })).getAttribute('maxlength')).toBe('200');
  });

  it('says so when nobody matches', async () => {
    const { api } = fakeApi({ 'GET /v1/users': list([]) });
    renderAt(<UsersScreen api={api} />);
    expect(await screen.findByText('No users found')).toBeTruthy();
  });

  it('changes a role, and reads the list again so it shows what the server has', async () => {
    let role: 'member' | 'admin' = 'member';
    const { api, of } = fakeApi({
      'GET /v1/users': () => list([ALICE, { ...BOB, role }]),
      'PATCH /v1/users/{id}': (r) => { role = (r.body as { role: 'member' | 'admin' }).role; return ok({ ...BOB, role }); },
    });
    renderAt(<UsersScreen api={api} />);
    await userEvent.selectOptions(await screen.findByLabelText('Role of Bob'), 'admin');
    await waitFor(() => { expect(of('GET', '/v1/users')).toHaveLength(2); });
    expect(of('PATCH', '/v1/users/{id}')[0]).toMatchObject({ params: { path: { id: 'u2' } }, body: { role: 'admin' } });
    expect((screen.getByLabelText('Role of Bob') as HTMLSelectElement).value).toBe('admin');
  });

  it('shows the role the server has when it refuses a change (the last administrator), after reading the list again', async () => {
    const { api, of } = fakeApi({
      'GET /v1/users': list([ALICE]),
      'PATCH /v1/users/{id}': { status: 409, body: { error: { code: 'last_admin', message: 'x' } } },
    });
    renderAt(<UsersScreen api={api} />);
    await userEvent.selectOptions(await screen.findByLabelText('Role of Alice'), 'member');
    await waitFor(() => { expect(of('GET', '/v1/users')).toHaveLength(2); });
    expect((screen.getByLabelText('Role of Alice') as HTMLSelectElement).value).toBe('admin');
  });

  it('suspends a user only after asking, naming the user', async () => {
    let suspended = false;
    const { api, of } = fakeApi({
      'GET /v1/users': () => list([ALICE, { ...BOB, suspended }]),
      'PATCH /v1/users/{id}': (r) => { suspended = (r.body as { suspended: boolean }).suspended; return ok({ ...BOB, suspended }); },
    });
    renderAt(<UsersScreen api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend Bob' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Suspend Bob?' });
    expect(of('PATCH', '/v1/users/{id}')).toHaveLength(0); // nothing is sent before the answer
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reinstate Bob' })).toBeTruthy(); });
    expect(of('PATCH', '/v1/users/{id}')[0]).toMatchObject({ params: { path: { id: 'u2' } }, body: { suspended: true } });
  });

  it('sends nothing when the question is answered No', async () => {
    const { api, of } = fakeApi({ 'GET /v1/users': list([BOB]) });
    renderAt(<UsersScreen api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend Bob' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(of('PATCH', '/v1/users/{id}')).toHaveLength(0);
  });

  it('reinstates a suspended user at once, without a question', async () => {
    const { api, of } = fakeApi({ 'GET /v1/users': list([CAROL]), 'PATCH /v1/users/{id}': ok({ ...CAROL, suspended: false }) });
    renderAt(<UsersScreen api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reinstate Carol' }));
    await waitFor(() => { expect(of('PATCH', '/v1/users/{id}')).toHaveLength(1); });
    expect(of('PATCH', '/v1/users/{id}')[0]?.body).toEqual({ suspended: false });
  });

  it('offers no way to delete a user: only Suspend or Reinstate', async () => {
    const { api } = fakeApi({ 'GET /v1/users': list([ALICE, BOB, CAROL]) });
    renderAt(<UsersScreen api={api} />);
    await screen.findByText('Alice');
    expect(screen.queryAllByRole('button', { name: /delete|remove/i })).toEqual([]);
    expect(screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Search').sort()).toEqual(['Reinstate', 'Suspend', 'Suspend']);
  });

  it('reads the next page on request, and the last page has no such button', async () => {
    const { api, of } = fakeApi({ 'GET /v1/users': (r) => (r.params.query?.['cursor'] === 'next-1' ? list([CAROL]) : list([ALICE], 'next-1')) });
    renderAt(<UsersScreen api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Carol')).toBeTruthy();
    expect(of('GET', '/v1/users').at(-1)?.params.query).toMatchObject({ cursor: 'next-1' });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('offers to try again when the users cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/users': () => (attempt++ === 0 ? { status: 503 } : list([ALICE])) });
    renderAt(<UsersScreen api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Alice')).toBeTruthy();
  });
});
