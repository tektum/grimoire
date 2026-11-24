import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AccessScreen } from '../../src/screens/admin/AccessScreen';
import '../support/dom';
import { fakeApi, ok, renderAt, user } from './support';

const COLLECTION = { id: 'c1', name: 'Dev', description: null, icon: null, color: null, position: 'p1', defaultPermission: 'read_write', myPermission: 'read-write' };
const ENTRIES = [
  { id: 'e1', principalType: 'group', principalId: 'g1', name: 'Team', permission: 'read_write' },
  { id: 'e2', principalType: 'user', principalId: 'u2', name: 'Bob', permission: 'read' },
];
const access = (defaultPermission: string | null, entries = ENTRIES) => ok({ defaultPermission, entries });
const show = (api: ReturnType<typeof fakeApi>['api']) => renderAt(<Routes><Route path="/admin/collections/:id/access" element={<AccessScreen api={api} />} /></Routes>, '/admin/collections/c1/access');
const base = { 'GET /v1/collections/{id}': ok(COLLECTION) };

describe('the collection access screen', () => {
  it('names the collection and shows its default permission and who has access', async () => {
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/access': access('read') });
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Access to Dev' })).toBeTruthy();
    expect((screen.getByLabelText('Everyone with an account can') as HTMLSelectElement).value).toBe('read');
    const rows = within(screen.getByRole('table', { name: 'Who has access' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => [within(r).getAllByRole('cell')[0]?.textContent, within(r).getAllByRole('cell')[1]?.textContent, (within(r).getByRole('combobox') as HTMLSelectElement).value])).toEqual([
      ['Team', 'Group', 'read_write'],
      ['Bob', 'User', 'read'],
    ]);
  });

  it('says so when only the default gives access', async () => {
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/access': access(null, []) });
    show(api);
    expect(await screen.findByText('No one has been given access one by one')).toBeTruthy();
    expect((screen.getByLabelText('Everyone with an account can') as HTMLSelectElement).value).toBe('none');
  });

  it('sets the default permission, or none, and reads the access again', async () => {
    let current: string | null = 'read';
    const { api, of } = fakeApi({
      ...base,
      'GET /v1/collections/{id}/access': () => access(current, []),
      'PATCH /v1/collections/{id}': (r) => { current = (r.body as { defaultPermission: string | null }).defaultPermission; return ok(COLLECTION); },
    });
    show(api);
    await userEvent.selectOptions(await screen.findByLabelText('Everyone with an account can'), 'read_write');
    await waitFor(() => { expect(of('PATCH', '/v1/collections/{id}')).toHaveLength(1); });
    expect(of('PATCH', '/v1/collections/{id}')[0]).toMatchObject({ params: { path: { id: 'c1' } }, body: { defaultPermission: 'read_write' } });
    await userEvent.selectOptions(screen.getByLabelText('Everyone with an account can'), 'none');
    await waitFor(() => { expect(of('PATCH', '/v1/collections/{id}')).toHaveLength(2); });
    expect(of('PATCH', '/v1/collections/{id}')[1]?.body).toEqual({ defaultPermission: null });
  });

  it('changes what one entry may do, by putting the same principal with the new permission', async () => {
    const { api, of } = fakeApi({ ...base, 'GET /v1/collections/{id}/access': access(null), 'PUT /v1/collections/{id}/access': ok(ENTRIES[1]) });
    show(api);
    await userEvent.selectOptions(await screen.findByLabelText('What Bob can do'), 'read_write');
    await waitFor(() => { expect(of('PUT', '/v1/collections/{id}/access')).toHaveLength(1); });
    expect(of('PUT', '/v1/collections/{id}/access')[0]).toMatchObject({ params: { path: { id: 'c1' } }, body: { principalType: 'user', principalId: 'u2', permission: 'read_write' } });
  });

  it('takes an entry away only after asking, naming who and what', async () => {
    const { api, of } = fakeApi({ ...base, 'GET /v1/collections/{id}/access': access(null), 'DELETE /v1/collections/{id}/access/{entryId}': { status: 204 } });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Bob from Dev?' });
    expect(of('DELETE', '/v1/collections/{id}/access/{entryId}')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => { expect(of('DELETE', '/v1/collections/{id}/access/{entryId}')).toHaveLength(1); });
    expect(of('DELETE', '/v1/collections/{id}/access/{entryId}')[0]?.params.path).toEqual({ id: 'c1', entryId: 'e2' });
  });

  it('gives access to a group chosen from the groups, with the permission chosen', async () => {
    const { api, of } = fakeApi({
      ...base,
      'GET /v1/collections/{id}/access': access(null, []),
      'GET /v1/groups': ok({ items: [{ id: 'g1', name: 'Team', memberCount: 2 }, { id: 'g2', name: 'Ops', memberCount: 0 }] }),
      'PUT /v1/collections/{id}/access': ok(ENTRIES[0]),
    });
    show(api);
    await userEvent.selectOptions(await screen.findByLabelText('Give access to'), 'group');
    await userEvent.selectOptions(await screen.findByLabelText('Group'), 'g2');
    await userEvent.selectOptions(screen.getByLabelText('Permission'), 'read_write');
    await userEvent.click(screen.getByRole('button', { name: 'Give access' }));
    await waitFor(() => { expect(of('PUT', '/v1/collections/{id}/access')).toHaveLength(1); });
    expect(of('PUT', '/v1/collections/{id}/access')[0]?.body).toEqual({ principalType: 'group', principalId: 'g2', permission: 'read_write' });
  });

  it('clears the group chosen once it has been given access, so a second click cannot send it again', async () => {
    let entries: typeof ENTRIES = [];
    const { api, of } = fakeApi({
      ...base,
      'GET /v1/collections/{id}/access': () => access(null, entries),
      'GET /v1/groups': ok({ items: [{ id: 'g1', name: 'Team', memberCount: 2 }, { id: 'g2', name: 'Ops', memberCount: 0 }] }),
      'PUT /v1/collections/{id}/access': () => { entries = [ENTRIES[0] as (typeof ENTRIES)[number]]; return ok(ENTRIES[0]); },
    });
    show(api);
    await userEvent.selectOptions(await screen.findByLabelText('Give access to'), 'group');
    await userEvent.selectOptions(await screen.findByLabelText('Group'), 'g1');
    await userEvent.click(screen.getByRole('button', { name: 'Give access' }));
    await waitFor(() => { expect((screen.getByLabelText('Group') as HTMLSelectElement).value).toBe(''); });
    expect((screen.getByRole('button', { name: 'Give access' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Give access' }));
    expect(of('PUT', '/v1/collections/{id}/access')).toHaveLength(1);
  });

  it('gives access to a person found by search', async () => {
    const { api, of } = fakeApi({
      ...base,
      'GET /v1/collections/{id}/access': access(null, []),
      'GET /v1/users': ok({ items: [user('u3', 'Carol')], nextCursor: null }),
      'PUT /v1/collections/{id}/access': ok(ENTRIES[1]),
    });
    show(api);
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Find a person' }), 'ca');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Give Carol access' }));
    await waitFor(() => { expect(of('PUT', '/v1/collections/{id}/access')).toHaveLength(1); });
    expect(of('PUT', '/v1/collections/{id}/access')[0]?.body).toEqual({ principalType: 'user', principalId: 'u3', permission: 'read' });
  });

  it('shows the not-found screen for a collection that cannot be read', async () => {
    const { api } = fakeApi({ 'GET /v1/collections/{id}': { status: 404 }, 'GET /v1/collections/{id}/access': { status: 404 } });
    show(api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it('offers to try again when the access cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ ...base, 'GET /v1/collections/{id}/access': () => (attempt++ === 0 ? { status: 503 } : access(null, [])) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Everyone with an account can')).toBeTruthy();
  });
});
