import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify, Toaster } from '../../src/ui/primitives';

/** A `matchMedia` that answers the dark-scheme query as given, and lets a test change its mind. */
function colourScheme(initial: boolean) {
  let dark = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('dark') ? dark : false; },
    media: query,
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  }));
  return { set: (value: boolean) => { dark = value; listeners.forEach((fn) => { fn(); }); } };
}
const toaster = () => document.querySelector('[data-sonner-toaster]') as HTMLElement;

beforeEach(() => { delete document.documentElement.dataset['theme']; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset['theme']; });

describe('the notices follow the theme', () => {
  it('are dark when the system is dark, light when it is light', async () => {
    colourScheme(true);
    const dark = render(<Toaster />);
    notify('Notice 1');
    await screen.findByText('Notice 1');
    expect(toaster().getAttribute('data-sonner-theme')).toBe('dark');
    dark.unmount();
    colourScheme(false);
    render(<Toaster />);
    notify('Notice 2');
    await screen.findAllByText('Notice 2');
    expect(toaster().getAttribute('data-sonner-theme')).toBe('light');
  });

  it('obey data-theme on the page over the system, as the tokens do', async () => {
    colourScheme(true);
    document.documentElement.dataset['theme'] = 'light';
    render(<Toaster />);
    notify('Notice 3');
    await screen.findByText('Notice 3');
    expect(toaster().getAttribute('data-sonner-theme')).toBe('light');
  });

  it('change with the system while open', async () => {
    const system = colourScheme(false);
    render(<Toaster />);
    notify('Notice 4');
    await screen.findByText('Notice 4');
    expect(toaster().getAttribute('data-sonner-theme')).toBe('light');
    act(() => { system.set(true); });
    expect(toaster().getAttribute('data-sonner-theme')).toBe('dark');
  });

  it('change with data-theme while open', async () => {
    colourScheme(false);
    render(<Toaster />);
    notify('Notice 5');
    await screen.findByText('Notice 5');
    await act(async () => { document.documentElement.dataset['theme'] = 'dark'; await Promise.resolve(); });
    expect(toaster().getAttribute('data-sonner-theme')).toBe('dark');
  });

  it('are painted with the tokens and the interface face, not with colours of their own', async () => {
    colourScheme(true);
    render(<Toaster />);
    notify('Notice 6');
    await screen.findByText('Notice 6');
    const style = toaster().getAttribute('style') ?? '';
    expect(style).toContain('--normal-bg: var(--paper-raised)');
    expect(style).toContain('--normal-text: var(--ink)');
    expect(style).toContain('--normal-border: var(--border)');
    expect((screen.getByText('Notice 6').closest('[data-sonner-toast]') as HTMLElement).getAttribute('style')).toContain('var(--font-ui)');
  });
});
