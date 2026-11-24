import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { adminApi, type MockUser } from './mock-api';

// An administrator changes a user's role and suspends a user; each result is read back through the screen after a reload. Needs a development build of the client
// (`bunx vite build --mode e2e`); the API is stood in for by `adminApi`.
const u = (id: string, name: string, role: MockUser['role'] = 'member', suspended = false): MockUser => ({ id, name, email: `${name.toLowerCase()}@dev.invalid`, role, suspended });

test('changes a role and suspends a user, and the screen shows both after a reload', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  const api = await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob'), u('u3', 'Carol')] });
  await page.goto('/admin/users');
  await page.getByLabel('Role of Bob').selectOption('viewer');
  await expect(page.getByLabel('Role of Bob')).toHaveValue('viewer');
  await page.getByRole('button', { name: 'Suspend Carol' }).click();
  await page.getByRole('alertdialog', { name: 'Suspend Carol?' }).getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByRole('button', { name: 'Reinstate Carol' })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Role of Bob')).toHaveValue('viewer');
  await expect(page.getByRole('button', { name: 'Reinstate Carol' })).toBeVisible();
  expect(api.state.users.map((x) => [x.name, x.role, x.suspended])).toEqual([['Alice', 'admin', false], ['Bob', 'viewer', false], ['Carol', 'member', true]]);
});

test('makes a group, adds and removes a member, and the screen shows each after a reload', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  const api = await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob'), u('u3', 'Carol')] });
  await page.goto('/admin/groups');
  await page.getByRole('textbox', { name: 'New group name' }).fill('Team');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Members of Team' })).toBeVisible();
  for (const [word, name] of [['bo', 'Bob'], ['ca', 'Carol']] as const) {
    await page.getByRole('searchbox', { name: 'Find a person to add' }).fill(word);
    await page.getByRole('button', { name: 'Find' }).click();
    await page.getByRole('button', { name: `Add ${name} to Team` }).click();
    await expect(page.getByRole('list', { name: 'Members' }).getByRole('heading', { level: 3, name })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Remove Bob from Team' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Bob' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('list', { name: 'Members' }).getByRole('heading', { level: 3 })).toHaveText(['Carol']);
  expect(api.state.members?.['g1']).toEqual(['u3']);
});

test('sets the access of a collection: the default, a group and a person, each read back after a reload', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  const api = await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob')], groups: [{ id: 'g1', name: 'Team' }] });
  await page.goto('/c/c1');
  await page.getByRole('link', { name: 'Manage access' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access to Dev' })).toBeVisible();
  await page.getByLabel('Everyone with an account can').selectOption('read');
  await page.getByLabel('Give access to').selectOption('group');
  await page.getByLabel('Group').selectOption('g1');
  await page.getByLabel('Permission').selectOption('read_write');
  await page.getByRole('button', { name: 'Give access' }).click();
  await expect(page.getByRole('table', { name: 'Who has access' }).getByRole('row')).toHaveCount(2);
  await page.getByLabel('Give access to').selectOption('user');
  await page.getByRole('searchbox', { name: 'Find a person' }).fill('bob');
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: 'Give Bob access' }).click();
  await expect(page.getByLabel('What Bob can do')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Everyone with an account can')).toHaveValue('read');
  await expect(page.getByLabel('What Team can do')).toHaveValue('read_write');
  await expect(page.getByLabel('What Bob can do')).toHaveValue('read_write');
  expect(api.state.access?.entries.map((e) => [e.principalType, e.principalId, e.permission])).toEqual([['group', 'g1', 'read_write'], ['user', 'u2', 'read_write']]);
});

test('searches by name and by email', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob'), u('u3', 'Carol')] });
  await page.goto('/admin/users');
  await page.getByRole('searchbox', { name: 'Search users' }).fill('carol@');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2, name: 'Carol' })).toBeVisible();
});
