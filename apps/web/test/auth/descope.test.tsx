import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The identity provider's packages are replaced: no test here loads the real SDK or the component, or reaches the provider.
const createSdk = vi.fn();
vi.mock('@descope/web-js-sdk', () => ({ createSdk: (config: unknown) => createSdk(config) }));
vi.mock('@descope/web-component', () => ({}));

afterEach(() => {
  cleanup();
  createSdk.mockReset();
});

describe('descope-sdk (the narrow interface over the web SDK)', () => {
  it('creates the SDK for the project with persisted tokens, and passes calls through', async () => {
    const sdk = { getSessionToken: vi.fn(() => 'tok'), isJwtExpired: vi.fn(() => true), refresh: vi.fn(async () => ({ ok: true, data: { secret: 'x' } })), logout: vi.fn(async () => ({ ok: true })) };
    createSdk.mockReturnValue(sdk);
    const { default: module } = await import('../../src/auth/descope-sdk');
    const client = module.create({ projectId: 'P-test' });
    expect(createSdk).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'P-test', persistTokens: true }));
    expect(client.getSessionToken()).toBe('tok');
    expect(client.isJwtExpired('t')).toBe(true);
    // Only `ok` is passed on: the response body (tokens) never leaves the SDK wrapper.
    expect(await client.refresh()).toEqual({ ok: true });
    await client.logout();
    expect(sdk.logout).toHaveBeenCalled();
  });
});

describe('descope-sdk: the endpoint of a regional project', () => {
  it('is given to the SDK when there is one, and left out when there is not', async () => {
    createSdk.mockReturnValue({ getSessionToken: vi.fn(), isJwtExpired: vi.fn(), refresh: vi.fn(), logout: vi.fn() });
    const { default: module } = await import('../../src/auth/descope-sdk');
    module.create({ projectId: 'P', baseUrl: 'https://api.eu1.example.test' });
    expect(createSdk).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'P', baseUrl: 'https://api.eu1.example.test' }));
    module.create({ projectId: 'P' });
    expect(createSdk.mock.lastCall?.[0]).not.toHaveProperty('baseUrl');
  });
});

describe('descope-signin (the flow as a custom element)', () => {
  it('sets base-url on the element for a regional project, and no attribute otherwise', async () => {
    const { default: DescopeSignIn } = await import('../../src/auth/descope-signin');
    const regional = render(<DescopeSignIn projectId="P" baseUrl="https://api.eu1.example.test" onSuccess={() => {}} onError={() => {}} />);
    expect(regional.container.querySelector('descope-wc')?.getAttribute('base-url')).toBe('https://api.eu1.example.test');
    cleanup();
    const plain = render(<DescopeSignIn projectId="P" onSuccess={() => {}} onError={() => {}} />);
    expect(plain.container.querySelector('descope-wc')?.hasAttribute('base-url')).toBe(false);
  });

  it('renders the provider element with the project and flow, and reports success and error events', async () => {
    const { default: DescopeSignIn } = await import('../../src/auth/descope-signin');
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { container } = render(<DescopeSignIn projectId="P-test" onSuccess={onSuccess} onError={onError} />);
    const element = container.querySelector('descope-wc')!;
    expect(element.getAttribute('project-id')).toBe('P-test');
    expect(element.getAttribute('flow-id')).toBe('sign-up-or-in');
    fireEvent(element, new CustomEvent('success'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    fireEvent(element, new CustomEvent('error'));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops listening when it goes away, and takes another flow id', async () => {
    const { default: DescopeSignIn } = await import('../../src/auth/descope-signin');
    const onSuccess = vi.fn();
    const { container, unmount } = render(<DescopeSignIn projectId="P" flowId="other-flow" onSuccess={onSuccess} onError={() => {}} />);
    const element = container.querySelector('descope-wc')!;
    expect(element.getAttribute('flow-id')).toBe('other-flow');
    unmount();
    element.dispatchEvent(new CustomEvent('success'));
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
