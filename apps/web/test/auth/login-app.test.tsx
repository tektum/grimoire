import { cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_TEXTS } from '../../src/screens/login/LoginScreen';
import { LoginApp, type LoginAppProps } from '../../src/screens/login/LoginApp';
import { resetClientOutdated } from '../../src/gate/outdated';
import { config, fakeStorage } from './support';

afterEach(() => {
  cleanup();
  resetClientOutdated();
  vi.restoreAllMocks();
});

const configResponse = (over = {}) => vi.fn(async () => new Response(JSON.stringify(config(over)), { status: 200 }));

function app(over: Partial<LoginAppProps> = {}) {
  return render(
    <LoginApp
      loadConfig={async () => ({ apiUrl: 'http://api.test', hiddenDisconnectMs: 1 })}
      search=""
      devBuild
      storage={fakeStorage().storage}
      go={() => {}}
      loadDevForm={async () => ({ default: () => <p>dev form</p> })}
      loadDescopeFlow={async () => ({ default: () => <p>provider flow</p> })}
      {...over}
    />,
  );
}

describe('the sign-in document as a whole', () => {
  it('shows the screen once the settings are read and the server has answered', async () => {
    vi.stubGlobal('fetch', configResponse({ local: true }));
    app();
    expect(await screen.findByText('dev form')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('says so, in an alert, when the settings of the page cannot be read (missing, an error, or malformed): never a blank page', async () => {
    app({ loadConfig: async () => Promise.reject(new Error('config.json: HTTP 404')) });
    expect((await screen.findByRole('alert')).textContent).toBe(LOGIN_TEXTS.configFailed);
    expect(document.body.textContent).not.toBe('');
  });

  it('shows the boundary, not a blank page, when a chunk of the screen fails to load', async () => {
    vi.stubGlobal('fetch', configResponse({ local: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app({ loadDevForm: async () => Promise.reject(new Error('chunk failed')) });
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong');
    vi.unstubAllGlobals();
  });

  it('ignores the answer of a settings read that a re-run of the effect has replaced (strict mode runs it twice): a late failure cannot overwrite the success', async () => {
    vi.stubGlobal('fetch', configResponse({ local: true }));
    let failFirst: (e: Error) => void = () => {};
    const first = new Promise<{ apiUrl: string; hiddenDisconnectMs: number }>((_, reject) => (failFirst = reject));
    const loadConfig = vi.fn<LoginAppProps['loadConfig']>().mockReturnValueOnce(first).mockResolvedValue({ apiUrl: 'http://api.test', hiddenDisconnectMs: 1 });
    render(
      <StrictMode>
        <LoginApp
          loadConfig={loadConfig}
          search=""
          devBuild
          storage={fakeStorage().storage}
          go={() => {}}
          loadDevForm={async () => ({ default: () => <p>dev form</p> })}
          loadDescopeFlow={async () => ({ default: () => <p>provider flow</p> })}
        />
      </StrictMode>,
    );
    expect(await screen.findByText('dev form')).toBeTruthy();
    expect(loadConfig).toHaveBeenCalledTimes(2);
    failFirst(new Error('config.json: HTTP 500')); // the first read fails after the second has already succeeded
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('dev form')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    vi.unstubAllGlobals();
  });
});
