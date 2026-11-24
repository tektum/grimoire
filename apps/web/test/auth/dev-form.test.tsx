import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DevSignInForm from '../../src/auth/DevSignInForm';
import { DEV_FORM_TEXTS, DEV_TOKEN_KEY } from '../../src/auth/dev-signin';
import { fakeStorage } from './support';

afterEach(cleanup);
const SECRET = 'ab12'.repeat(8);

function renderForm(fetchFn: typeof fetch) {
  const { storage, map } = fakeStorage();
  const onSignedIn = vi.fn();
  render(<DevSignInForm options={{ apiUrl: 'http://api', storage, fetch: fetchFn }} onSignedIn={onSignedIn} />);
  return { storage, map, onSignedIn };
}
const fill = (userId: string, role: string, secret: string) => {
  fireEvent.change(screen.getByLabelText('User id'), { target: { value: userId } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: role } });
  fireEvent.change(screen.getByLabelText('Secret'), { target: { value: secret } });
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
};

describe('the development sign-in form', () => {
  it('has a user id, a role of three choices, and a secret in a password field', () => {
    renderForm(vi.fn() as never);
    expect(screen.getByLabelText('User id').getAttribute('name')).toBe('userId');
    expect((screen.getByLabelText('Secret') as HTMLInputElement).type).toBe('password');
    expect([...(screen.getByLabelText('Role') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['admin', 'member', 'viewer']);
  });

  it('signs in alice as member: asks /v1/me with the bearer, stores the token, and tells the screen', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const t = renderForm(fetchFn as never);
    fill('alice', 'member', SECRET);
    await waitFor(() => expect(t.onSignedIn).toHaveBeenCalledTimes(1));
    expect(t.storage.get(DEV_TOKEN_KEY)).toBe(`dev:${SECRET}:alice:member`);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ Authorization: `Bearer dev:${SECRET}:alice:member` });
    expect(init.credentials).toBe('omit');
  });

  it('refuses a bad user id and a short secret with their texts, before any request', async () => {
    const fetchFn = vi.fn();
    const t = renderForm(fetchFn as never);
    fill('Alice', 'member', SECRET);
    expect((await screen.findByRole('alert')).textContent).toBe(DEV_FORM_TEXTS.userId);
    fill('alice', 'member', 'short');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(DEV_FORM_TEXTS.secret));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(t.onSignedIn).not.toHaveBeenCalled();
    expect(t.map.size).toBe(0);
  });

  it('shows the rejection text and never the secret when the server answers 401', async () => {
    const t = renderForm(vi.fn(async () => new Response('{}', { status: 401 })) as never);
    fill('alice', 'viewer', SECRET);
    expect((await screen.findByRole('alert')).textContent).toBe(DEV_FORM_TEXTS.rejected);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(t.onSignedIn).not.toHaveBeenCalled();
  });
});
