import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type AppProps } from '../../src/app/App';
import { routeObjects } from '../../src/app/router';
import { createDevSignIn, DEV_TOKEN_EXPIRES_KEY, DEV_TOKEN_KEY } from '../../src/auth/dev-signin';
import { GATE_MESSAGES } from '../../src/gate/messages';
import { resetClientOutdated } from '../../src/gate/outdated';
import { config, fakeStorage } from './support';

afterEach(() => {
  cleanup();
  resetClientOutdated();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HERE = '/p/some-page-ab12cd?x=1';
const SECRET = 'ab12'.repeat(8);
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The app with a configuration answer, an API that answers by path, and a spy where the browser would leave for the sign-in document. */
function run(options: { token?: string; local?: boolean; devBuild?: boolean; api?: (request: Request) => Response; configStatus?: number } = {}) {
  const { storage } = fakeStorage();
  if (options.token !== undefined) {
    storage.set(DEV_TOKEN_KEY, options.token);
    storage.set(DEV_TOKEN_EXPIRES_KEY, String(Date.now() + 3_600_000));
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(options.configStatus ?? 200, config({ local: options.local ?? true }))),
  );
  const requests: Request[] = [];
  const redirect = vi.fn();
  const api = options.api ?? (() => json(200, { name: 'alice', role: 'member', email: 'alice@dev.invalid', id: 'u1' }));
  const props: AppProps = {
    loadConfig: async () => ({ apiUrl: 'http://api.test', hiddenDisconnectMs: 1 }),
    storage,
    loadDescope: async () => Promise.reject(new Error('unused')),
    loadDevSignIn: options.devBuild === false ? null : async (apiUrl, s) => createDevSignIn({ apiUrl, storage: s }),
    router: () => createMemoryRouter(routeObjects(), { initialEntries: [HERE] }),
    here: () => HERE,
    redirect,
    fetch: async (request) => {
      requests.push(request);
      return api(request);
    },
  };
  render(<App {...props} />);
  return { redirect, requests, storage };
}

describe('the app wired to the gate and the session', () => {
  it('sends a signed-out visitor to the sign-in document with the page to come back to, and renders nothing of the app', async () => {
    const t = run();
    await waitFor(() => expect(t.redirect).toHaveBeenCalledTimes(1));
    expect(t.redirect).toHaveBeenCalledWith('/login?return=%2Fp%2Fsome-page-ab12cd%3Fx%3D1');
    expect(screen.queryByRole('main')).toBeNull();
    expect(t.requests).toHaveLength(0);
  });

  it('renders the app for a signed-in development session, and every API call carries the bearer, the version header and no cookie', async () => {
    const t = run({ token: `dev:${SECRET}:alice:member` });
    expect(await screen.findByRole('heading', { level: 1, name: 'Page' })).toBeTruthy();
    await waitFor(() => expect(t.requests.length).toBeGreaterThan(0));
    for (const request of t.requests) {
      expect(request.headers.get('Authorization')).toBe(`Bearer dev:${SECRET}:alice:member`);
      expect(request.headers.get('X-Grimoire-Client-Version')).toBe('0.0.0');
      expect(request.credentials).toBe('omit');
      expect(request.headers.has('cookie')).toBe(false);
    }
    expect(t.redirect).not.toHaveBeenCalled();
  });

  it('shows who is signed in, with the role', async () => {
    run({ token: `dev:${SECRET}:alice:admin`, api: () => json(200, { name: 'alice', role: 'admin', email: 'a@dev.invalid', id: 'u1' }) });
    expect((await screen.findByTestId('user-name')).textContent).toBe('alice');
    expect(screen.getByTestId('user-role').textContent).toBe('admin');
  });

  it('shows a viewer as read-only', async () => {
    run({ token: `dev:${SECRET}:vera:viewer`, api: () => json(200, { name: 'vera', role: 'viewer', email: 'v@dev.invalid', id: 'u2' }) });
    expect((await screen.findByTestId('user-role')).textContent).toBe('viewer (read-only)');
    expect(screen.getByTestId('user-role').getAttribute('data-role')).toBe('viewer');
  });

  it.each([
    [401, 'unauthenticated', 'expired'],
    [403, 'account_suspended', 'suspended'],
    [403, 'not_allowed', 'not-allowed'],
  ])('a %s %s answer ends the session and goes to the sign-in document with reason=%s', async (status, code, reason) => {
    const t = run({ token: `dev:${SECRET}:alice:member`, api: () => json(status, { error: { code } }) });
    await waitFor(() => expect(t.redirect).toHaveBeenCalled());
    expect(t.redirect).toHaveBeenCalledWith(`/login?return=%2Fp%2Fsome-page-ab12cd%3Fx%3D1&reason=${reason}`);
    expect(t.storage.get(DEV_TOKEN_KEY)).toBeNull();
  });

  it('signs out from the badge: the token is gone and the browser leaves for the sign-in document without a reason', async () => {
    const t = run({ token: `dev:${SECRET}:alice:member` });
    (await screen.findByRole('button', { name: 'Sign out' })).click();
    await waitFor(() => expect(t.redirect).toHaveBeenCalledWith('/login?return=%2Fp%2Fsome-page-ab12cd%3Fx%3D1'));
    expect(t.storage.get(DEV_TOKEN_KEY)).toBeNull();
  });

  it('keeps the Sign out button, without a name or role, when /v1/me fails: the way out does not depend on that answer', async () => {
    const t = run({ token: `dev:${SECRET}:alice:member`, api: () => json(500, { error: { code: 'internal' } }) });
    const button = await screen.findByRole('button', { name: 'Sign out' });
    await waitFor(() => expect(t.requests.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('user-name')).toBeNull();
    expect(screen.queryByTestId('user-role')).toBeNull();
    button.click();
    await waitFor(() => expect(t.redirect).toHaveBeenCalledWith('/login?return=%2Fp%2Fsome-page-ab12cd%3Fx%3D1'));
  });

  it('a 426 client_too_old answer replaces the app with the reload text, and no further call is sent', async () => {
    const t = run({ token: `dev:${SECRET}:alice:member`, api: () => json(426, { error: { code: 'client_too_old' } }) });
    expect(await screen.findByText(GATE_MESSAGES.outdated)).toBeTruthy();
    expect(document.body.textContent).toBe(GATE_MESSAGES.outdated);
    const sent = t.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.requests).toHaveLength(sent);
  });

  it('ignores a development token in a production build (no development sign-in loaded) and asks for a sign-in', async () => {
    const t = run({ token: `dev:${SECRET}:alice:member`, devBuild: false });
    await waitFor(() => expect(t.redirect).toHaveBeenCalled());
    expect(t.requests).toHaveLength(0);
  });

  it('shows the gate messages before anything else: a server that is not ready', async () => {
    run({ configStatus: 503 });
    expect(await screen.findByText(GATE_MESSAGES.notReady)).toBeTruthy();
  });

  it('says so, in an alert, when the settings of the page cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { storage } = fakeStorage();
    render(
      <App
        loadConfig={async () => Promise.reject(new Error('config.json: HTTP 404'))}
        storage={storage}
        loadDescope={async () => Promise.reject(new Error('unused'))}
        loadDevSignIn={null}
        router={() => createMemoryRouter(routeObjects())}
        here={() => HERE}
        redirect={vi.fn()}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('could not be read');
  });
});
