import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { GroupsScreen } from '../../src/screens/admin/GroupsScreen';
import '../support/dom';
import { fakeApi, ok, renderAt, user } from './support';

const TEAM = { id: 'g1', name: 'Team', memberCount: 2 };
const OPS = { id: 'g2', name: 'Ops', memberCount: 0 };
const BOB = user('u2', 'Bob');
const CAROL = user('u3', 'Carol');
const Where = () => <output aria-label="location">{`${useLocation().pathname}${useLocation().search}`}</output>;
const show = (api: ReturnType<typeof fakeApi>['api'], path = '/admin/groups') =>
  renderAt(<><Routes><Route path="/admin/groups" element={<GroupsScreen api={api} />} /></Routes><Where /></>, path);
const groups = (items: unknown[]) => ok({ items });

describe('the groups screen', () => {
  it('lists the groups with their member counts', async () => {
    const { api } = fakeApi({ 'GET /v1/groups': groups([TEAM, OPS]) });
    show(api);
    await screen.findByText('Team');
    expect(screen.getAllByRole('listitem').map((r) => [within(r).getByRole('link').textContent, within(r).getByText(/member/).textContent])).toEqual([
      ['Team', '2 members'],
      ['Ops', '0 members'],
    ]);
  });

  it('says so when there is no group', async () => {
    const { api } = fakeApi({ 'GET /v1/groups': groups([]) });
    show(api);
    expect(await screen.findByText('No groups yet')).toBeTruthy();
  });

  it('makes a group, and reads the list again', async () => {
    let made = false;
    const { api, of } = fakeApi({
      'GET /v1/groups': () => groups(made ? [TEAM] : []),
      'POST /v1/groups': () => { made = true; return ok(TEAM, 201); },
    });
    show(api);
    await userEvent.type(await screen.findByRole('textbox', { name: 'New group name' }), 'Team');
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('link', { name: 'Team' })).toBeTruthy();
    expect(of('POST', '/v1/groups')[0]?.body).toEqual({ name: 'Team' });
    expect((screen.getByRole('textbox', { name: 'New group name' }) as HTMLInputElement).value).toBe('');
  });

  it('keeps the name typed and reads the list again when the name is taken (the wrapper says so)', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([TEAM]), 'POST /v1/groups': { status: 409, body: { error: { code: 'name_taken', message: 'x' } } } });
    show(api);
    await userEvent.type(await screen.findByRole('textbox', { name: 'New group name' }), 'Team');
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => { expect(of('GET', '/v1/groups')).toHaveLength(2); });
    expect((screen.getByRole('textbox', { name: 'New group name' }) as HTMLInputElement).value).toBe('Team');
  });

  it('does not send an empty name', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([]) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Create group' }));
    expect(of('POST', '/v1/groups')).toHaveLength(0);
  });

  it('renames a group in place', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([TEAM]), 'PATCH /v1/groups/{id}': ok({ ...TEAM, name: 'Crew' }) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Team' }));
    const field = screen.getByRole('textbox', { name: 'New name for Team' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Crew{Enter}');
    await waitFor(() => { expect(of('PATCH', '/v1/groups/{id}')).toHaveLength(1); });
    expect(of('PATCH', '/v1/groups/{id}')[0]).toMatchObject({ params: { path: { id: 'g1' } }, body: { name: 'Crew' } });
  });

  it('keeps the name when the rename is cancelled with Escape', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([TEAM]) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Team' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for Team' }), 'x{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New name for Team' })).toBeNull();
    expect(of('PATCH', '/v1/groups/{id}')).toHaveLength(0);
  });

  it('deletes a group only after asking, naming it', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([TEAM]), 'DELETE /v1/groups/{id}': { status: 204 } });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Team' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete the group Team?' });
    expect(of('DELETE', '/v1/groups/{id}')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => { expect(of('DELETE', '/v1/groups/{id}')).toHaveLength(1); });
    expect(of('DELETE', '/v1/groups/{id}')[0]?.params.path).toEqual({ id: 'g1' });
  });

  it('shows the members of the group chosen, and keeps the choice in the address', async () => {
    const { api, of } = fakeApi({ 'GET /v1/groups': groups([TEAM, OPS]), 'GET /v1/groups/{id}/members': ok({ items: [BOB, CAROL] }) });
    show(api);
    await userEvent.click(await screen.findByRole('link', { name: 'Team' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Members of Team' })).toBeTruthy();
    expect(screen.getByLabelText('location').textContent).toBe('/admin/groups?group=g1');
    expect(of('GET', '/v1/groups/{id}/members')[0]?.params.path).toEqual({ id: 'g1' });
    expect(within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem').map((r) => within(r).getByRole('heading').textContent)).toEqual(['Bob', 'Carol']);
  });

  it('shows the group named in the address when the page opens', async () => {
    const { api } = fakeApi({ 'GET /v1/groups': groups([TEAM]), 'GET /v1/groups/{id}/members': ok({ items: [BOB] }) });
    show(api, '/admin/groups?group=g1');
    expect(await screen.findByRole('heading', { level: 2, name: 'Members of Team' })).toBeTruthy();
  });

  it('removes a member, and reads the members again', async () => {
    let left = [BOB, CAROL];
    const { api, of } = fakeApi({
      'GET /v1/groups': groups([TEAM]),
      'GET /v1/groups/{id}/members': () => ok({ items: left }),
      'DELETE /v1/groups/{id}/members/{userId}': () => { left = [CAROL]; return { status: 204 }; },
    });
    show(api, '/admin/groups?group=g1');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Bob from Team' }));
    await waitFor(() => { expect(screen.queryByRole('heading', { level: 3, name: 'Bob' })).toBeNull(); });
    expect(of('DELETE', '/v1/groups/{id}/members/{userId}')[0]?.params.path).toEqual({ id: 'g1', userId: 'u2' });
    expect(screen.getByRole('heading', { level: 3, name: 'Carol' })).toBeTruthy();
  });

  it('adds a member found by search, who is then listed; people already in the group are not offered', async () => {
    let members = [BOB];
    const { api, of } = fakeApi({
      'GET /v1/groups': groups([TEAM]),
      'GET /v1/groups/{id}/members': () => ok({ items: members }),
      'GET /v1/users': () => ok({ items: [BOB, CAROL], nextCursor: null }),
      'PUT /v1/groups/{id}/members/{userId}': () => { members = [BOB, CAROL]; return { status: 204 }; },
    });
    show(api, '/admin/groups?group=g1');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Find a person to add' }), 'ca');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('button', { name: 'Add Carol to Team' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Bob to Team' })).toBeNull();
    expect(of('GET', '/v1/users')[0]?.params.query).toMatchObject({ q: 'ca' });
    await userEvent.click(screen.getByRole('button', { name: 'Add Carol to Team' }));
    await waitFor(() => { expect(screen.getByRole('heading', { level: 3, name: 'Carol' })).toBeTruthy(); });
    expect(of('PUT', '/v1/groups/{id}/members/{userId}')[0]?.params.path).toEqual({ id: 'g1', userId: 'u3' });
  });

  it('keeps looking past people already in the group: Show more reaches the next page of matches', async () => {
    const { api, of } = fakeApi({
      'GET /v1/groups': groups([TEAM]),
      'GET /v1/groups/{id}/members': ok({ items: [BOB] }),
      'GET /v1/users': (r) => ((r.params.query as { cursor?: string } | undefined)?.cursor === undefined ? ok({ items: [BOB], nextCursor: 'c2' }) : ok({ items: [CAROL], nextCursor: null })),
    });
    show(api, '/admin/groups?group=g1');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Find a person to add' }), 'dev');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(screen.queryByText('No one to add')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'Add Carol to Team' })).toBeTruthy();
    expect(of('GET', '/v1/users')[1]?.params.query).toMatchObject({ q: 'dev', cursor: 'c2' });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says No one to add only when the last page has been read and no one is left', async () => {
    const { api } = fakeApi({ 'GET /v1/groups': groups([TEAM]), 'GET /v1/groups/{id}/members': ok({ items: [BOB] }), 'GET /v1/users': ok({ items: [BOB], nextCursor: null }) });
    show(api, '/admin/groups?group=g1');
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Find a person to add' }), 'bob');
    await userEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('No one to add')).toBeTruthy();
  });

  it('says so when the group has no member', async () => {
    const { api } = fakeApi({ 'GET /v1/groups': groups([OPS]), 'GET /v1/groups/{id}/members': ok({ items: [] }) });
    show(api, '/admin/groups?group=g2');
    expect(await screen.findByText('No members yet')).toBeTruthy();
  });

  it('offers to try again when the groups cannot be read', async () => {
    let attempt = 0;
    const { api } = fakeApi({ 'GET /v1/groups': () => (attempt++ === 0 ? { status: 503 } : groups([TEAM])) });
    show(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Team' })).toBeTruthy();
  });
});
