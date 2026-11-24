import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';
import { renderPage, settle, width } from './support';

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); width(1400); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the outline of a page', () => {
  it('renders no list and no empty nav for a page with no heading', async () => {
    const { container } = renderPage([]);
    await settle();
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
    expect(container.querySelector('nav, ul, ol')).toBeNull();
    expect(container.querySelector('.page-margin')?.childElementCount).toBe(0); // the empty margin hides itself (page.css)
  });

  it('omits a heading that holds only whitespace, and lists the others', async () => {
    renderPage([[1, 'Alpha'], [2, '   '], [2, '\u00a0\n'], [2, 'Beta']]);
    await settle();
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Alpha', 'Beta']);
  });

  it('lists the headings in the order of the page, A, B, C, with B one step in', async () => {
    renderPage([[1, 'A'], [2, 'B'], [1, 'C']]);
    await settle();
    const links = within(screen.getByRole('navigation', { name: 'Page outline' })).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('data-indent')])).toEqual([['A', '0'], ['B', '1'], ['C', '0']]);
  });

  it('follows the document, a moment after it changes (200 ms), and not on every keystroke', async () => {
    const { set } = renderPage([[1, 'A']]);
    await settle();
    set([[1, 'A'], [2, 'New heading']]);
    await settle(100);
    expect(screen.queryByRole('link', { name: 'New heading' })).toBeNull();
    await settle(150);
    expect(screen.getByRole('link', { name: 'New heading' })).toBeTruthy();
  });

  it('goes away when the last heading is deleted, and comes back with the next', async () => {
    const { set } = renderPage([[1, 'A']]);
    await settle();
    set([]);
    await settle();
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
    set([[3, 'Again']]);
    await settle();
    expect(screen.getByRole('link', { name: 'Again' })).toBeTruthy();
  });

  it('is not rendered below 1,200 pixels', async () => {
    width(1000);
    renderPage([[1, 'A'], [2, 'B']]);
    await settle();
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
  });

  it('a click puts the cursor in the heading and scrolls it into view', async () => {
    const { editor } = renderPage([[1, 'A'], [2, 'B'], [1, 'C']]);
    await settle();
    const target = editor.querySelectorAll('h1')[1] as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    await userEvent.click(screen.getByRole('link', { name: 'C' }));
    expect(scroll).toHaveBeenCalledTimes(1);
    const selection = window.getSelection();
    expect(target.contains(selection?.anchorNode ?? null)).toBe(true);
    expect(selection?.isCollapsed).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it('leaves the page where it is when the heading is already in the window, and brings it to the middle when it is not', async () => {
    const { editor } = renderPage([[1, 'A'], [1, 'B']]);
    await settle();
    const target = editor.querySelectorAll('h1')[1] as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    target.getBoundingClientRect = () => ({ top: 100, bottom: 140 }) as DOMRect;
    await userEvent.click(screen.getByRole('link', { name: 'B' }));
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    target.getBoundingClientRect = () => ({ top: 5000, bottom: 5040 }) as DOMRect;
    await userEvent.click(screen.getByRole('link', { name: 'B' }));
    expect(scroll).toHaveBeenLastCalledWith({ block: 'center' });
  });

  it('marks the heading the cursor is in as the current one', async () => {
    const { editor } = renderPage([[1, 'A'], [2, 'B'], [1, 'C']]);
    await settle();
    const second = editor.querySelectorAll('h2')[0] as HTMLElement;
    editor.focus();
    await act(async () => {
      window.getSelection()?.collapse(second, 0);
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(250);
    });
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'location', null]);
  });

  it('is one stop of the Tab key: only one link is tabbable, and the arrow keys, Home and End move between the links', async () => {
    renderPage([[1, 'A'], [2, 'B'], [1, 'C']]);
    await settle();
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.tabIndex)).toEqual([0, -1, -1]);
    links[0]?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(links[1]);
    expect(links.map((a) => a.tabIndex)).toEqual([-1, 0, -1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(links[2]);
    await userEvent.keyboard('{ArrowDown}'); // already at the end
    expect(document.activeElement).toBe(links[2]);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(links[1]);
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(links[0]);
    await userEvent.keyboard('{ArrowUp}'); // already at the start
    expect(document.activeElement).toBe(links[0]);
    await userEvent.keyboard('x'); // any other key is left alone
    expect(document.activeElement).toBe(links[0]);
  });

  it('Enter on a link goes to its heading', async () => {
    const { editor } = renderPage([[1, 'A'], [1, 'B']]);
    await settle();
    const target = editor.querySelectorAll('h1')[1] as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    screen.getByRole('link', { name: 'B' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(target.contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it('follows the window: shown when it grows to 1,200 pixels, gone when it narrows', async () => {
    let listener: () => void = () => undefined;
    let wide = false;
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return wide; },
      media: '(min-width: 1200px)',
      addEventListener: (_: string, fn: () => void) => { listener = fn; },
      removeEventListener: () => undefined,
    }));
    renderPage([[1, 'A']]);
    await settle();
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
    wide = true;
    await act(async () => { listener(); await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByRole('link', { name: 'A' })).toBeTruthy();
    wide = false;
    await act(async () => { listener(); await vi.advanceTimersByTimeAsync(250); });
    expect(screen.queryByRole('navigation', { name: 'Page outline' })).toBeNull();
  });
});
