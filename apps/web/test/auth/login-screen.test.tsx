import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGN_OUT_NOTICES } from '../../src/auth';
import { LOGIN_TEXTS, LoginScreen, type LoginScreenProps } from '../../src/screens/login/LoginScreen';
import { config, fakeStorage } from './support';

afterEach(cleanup);

/** The screen with spies for the two chunk loaders and for where it goes. */
function screenWith(over: Partial<LoginScreenProps> & { devFormText?: string }) {
  const go = vi.fn();
  const DevForm: ComponentType<{ onSignedIn: () => void }> = ({ onSignedIn }) => (
    <button type="button" onClick={onSignedIn}>
      {over.devFormText ?? 'dev form'}
    </button>
  );
  const Descope: ComponentType<{ projectId: string; baseUrl?: string; onSuccess: () => void; onError: () => void }> = ({ projectId, baseUrl, onSuccess, onError }) => (
    <>
      <button type="button" onClick={onSuccess}>{`descope ${projectId}${baseUrl === undefined ? '' : ` at ${baseUrl}`}`}</button>
      <button type="button" onClick={onError}>
        flow error
      </button>
    </>
  );
  const loadDevForm = vi.fn(async () => ({ default: DevForm as never }));
  const loadDescopeFlow = vi.fn(async () => ({ default: Descope as never }));
  render(
    <LoginScreen
      config={config({ local: true })}
      apiUrl="http://api"
      search=""
      devBuild
      storage={fakeStorage().storage}
      go={go}
      loadDevForm={loadDevForm}
      loadDescopeFlow={loadDescopeFlow}
      {...over}
    />,
  );
  return { go, loadDevForm, loadDescopeFlow };
}

describe('the sign-in screen', () => {
  it('shows the development form, and requests only its chunk, when the server is local in a development or test build', async () => {
    const t = screenWith({});
    expect(await screen.findByRole('button', { name: 'dev form' })).toBeTruthy();
    expect(t.loadDevForm).toHaveBeenCalledTimes(1);
    expect(t.loadDescopeFlow).not.toHaveBeenCalled();
  });

  it('says "This server is in local development mode; sign-in is unavailable in this build" in a production build, and loads neither chunk', () => {
    const t = screenWith({ devBuild: false });
    expect(screen.getByText(LOGIN_TEXTS.localInProduction)).toBeTruthy();
    expect(LOGIN_TEXTS.localInProduction).toBe('This server is in local development mode; sign-in is unavailable in this build');
    expect(screen.queryByRole('button')).toBeNull();
    expect(t.loadDevForm).not.toHaveBeenCalled();
    expect(t.loadDescopeFlow).not.toHaveBeenCalled();
  });

  it('shows the provider flow with the project id, and requests only its chunk, when the server is not local', async () => {
    const t = screenWith({ config: config({ local: false, providerProjectId: 'P-test' }) });
    expect(await screen.findByRole('button', { name: 'descope P-test' })).toBeTruthy();
    expect(t.loadDescopeFlow).toHaveBeenCalledTimes(1);
    expect(t.loadDevForm).not.toHaveBeenCalled();
  });

  it('gives the provider flow the endpoint of a regional project', async () => {
    screenWith({ config: config({ local: false, providerProjectId: 'P-test', providerBaseUrl: 'https://api.eu1.example.test' }) });
    expect(await screen.findByRole('button', { name: 'descope P-test at https://api.eu1.example.test' })).toBeTruthy();
  });

  it('puts the provider flow in an element of its own, apart from the notices next to it', async () => {
    const { container } = render(<div />); // keeps the helper's own render out of the way
    container.remove();
    screenWith({ config: config({ local: false, providerProjectId: 'P-test' }), search: '?reason=expired' });
    const flow = (await screen.findByRole('button', { name: 'descope P-test' })).closest('.login-flow');
    expect(flow).not.toBeNull();
    expect(flow?.parentElement?.tagName).toBe('MAIN');
    expect(screen.getByRole('status').parentElement).toBe(flow?.parentElement);
    expect(flow?.contains(screen.getByRole('status'))).toBe(false);
  });

  it('shows "Sign-in did not finish. Try again." as an alert when the provider flow reports an error, and clears it when the flow then succeeds', async () => {
    const t = screenWith({ config: config({ local: false, providerProjectId: 'P-test' }) });
    (await screen.findByRole('button', { name: 'flow error' })).click();
    expect((await screen.findByRole('alert')).textContent).toBe(LOGIN_TEXTS.failed);
    expect(LOGIN_TEXTS.failed).toBe('Sign-in did not finish. Try again.');
    expect(t.go).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'descope P-test' }).click();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(t.go).toHaveBeenCalledWith('/');
  });

  it('says so in plain words, and loads nothing, when the server is not local and has no project id', () => {
    const t = screenWith({ config: config({ local: false, providerProjectId: null }) });
    expect(screen.getByText(LOGIN_TEXTS.noProject)).toBeTruthy();
    expect(t.loadDescopeFlow).not.toHaveBeenCalled();
    expect(t.loadDevForm).not.toHaveBeenCalled();
  });

  it('forces the provider flow with ?flow=descope in a development or test build only', async () => {
    const forced = screenWith({ config: config({ local: false, providerProjectId: 'P-test' }), search: '?flow=descope' });
    expect(await screen.findByRole('button', { name: 'descope P-test' })).toBeTruthy();
    expect(forced.loadDescopeFlow).toHaveBeenCalled();
    cleanup();
    const local = screenWith({ config: config({ local: true, providerProjectId: 'P-test' }), search: '?flow=descope' });
    expect(await screen.findByRole('button', { name: 'descope P-test' })).toBeTruthy();
    expect(local.loadDevForm).not.toHaveBeenCalled();
    cleanup();
    const production = screenWith({ config: config({ local: true }), devBuild: false, search: '?flow=descope' });
    expect(screen.getByText(LOGIN_TEXTS.localInProduction)).toBeTruthy();
    expect(production.loadDescopeFlow).not.toHaveBeenCalled();
  });

  it('goes to the ?return= path after a sign-in, and to / for a value that is not a path of the app', async () => {
    const t = screenWith({ search: `?return=${encodeURIComponent('/p/some-page-ab12cd?x=1')}` });
    (await screen.findByRole('button', { name: 'dev form' })).click();
    expect(t.go).toHaveBeenCalledWith('/p/some-page-ab12cd?x=1');
    cleanup();
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '///evil', 'evil', '/javascript:alert(1)', '%2F%2Fevil.example', '', '\\\\evil']) {
      const u = screenWith({ search: `?return=${encodeURIComponent(bad)}` });
      (await screen.findByRole('button', { name: 'dev form' })).click();
      await waitFor(() => expect(u.go).toHaveBeenCalled());
      expect([bad, u.go.mock.calls[0]?.[0]]).toEqual([bad, '/']);
      cleanup();
    }
  });

  it.each([['expired'], ['suspended'], ['not-allowed']] as const)('shows the notice of a session that ended (%s)', (reason) => {
    screenWith({ search: `?reason=${reason}` });
    expect(screen.getByRole('status').textContent).toBe(SIGN_OUT_NOTICES[reason]);
  });

  it('shows no notice for an unknown or missing reason', () => {
    screenWith({ search: '?reason=<b>x</b>' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
