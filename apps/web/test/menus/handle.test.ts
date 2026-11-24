import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandleHost } from '../../src/editor/menus/handle';
import { plainEditor } from './support';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
let current: Editor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});
const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const handles = (): number => document.querySelectorAll('.block-handle').length;

describe('the block handle in the editor', () => {
  it('is one element for the editor, with a button for the menu, and it is gone with the editor', async () => {
    current = await plainEditor('First.\n\nSecond.');
    const t = current;
    const view = t.view();
    view.dispatch(view.state.tr.insertText('x', 1));
    await frame();
    await frame();
    await vi.waitFor(() => expect(handles()).toBe(1));
    expect(document.querySelector('.block-handle button')?.getAttribute('aria-label')).toBe('Block menu');
    // A change after that does not make another one.
    view.dispatch(view.state.tr.insertText('y', 1));
    await frame();
    await frame();
    expect(handles()).toBe(1);
    await t.destroy();
    current = null;
    expect(handles()).toBe(0);
  });

  it('is not draggable: a block is changed with the menu, not moved', async () => {
    current = await plainEditor('First.\n\nSecond.');
    const view = current.view();
    view.dispatch(view.state.tr.insertText('x', 1));
    await vi.waitFor(() => expect(handles()).toBe(1));
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    document.querySelector('.block-handle')!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });
});

describe('the handle button, its menu and its keys', () => {
  async function handleOnSecond(): Promise<{ t: Editor; host: HTMLElement; secondStart: number; setActive: (on: boolean) => void }> {
    current = await plainEditor('First.\n\nSecond.');
    const t = current;
    const doc = t.view().state.doc;
    const secondStart = doc.child(0).nodeSize;
    let on = true;
    const { host } = createHandleHost(await t.editor.action((ctx) => ctx), () => (on ? { $pos: t.view().state.doc.resolve(secondStart) } : null));
    document.body.append(host);
    return { t, host, secondStart, setActive: (value) => void (on = value) };
  }
  const button = (host: HTMLElement): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button.block-handle-button')!;
  const press = (host: HTMLElement, key: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    host.dispatchEvent(event);
    return event;
  };
  const optionIds = (host: HTMLElement): string[] => Array.from(host.querySelectorAll('[role=option]')).map((o) => o.id);

  it('is drawn at once with its button; a press opens the menu with every kind and a second press closes it', async () => {
    const { host } = await handleOnSecond();
    expect(button(host).getAttribute('aria-expanded')).toBe('false'); // drawn before any frame: the library places it by its size
    button(host).click();
    await vi.waitFor(() => expect(host.querySelectorAll('[role=option]')).toHaveLength(14));
    button(host).click();
    await vi.waitFor(() => expect(host.querySelector('[role=listbox]')).toBeNull());
    host.remove();
  });

  it('a choice turns the block the handle is on into that kind, whatever the cursor was in; the key move wraps; Enter chooses the active one', async () => {
    const { t, host } = await handleOnSecond();
    button(host).click();
    await vi.waitFor(() => expect(optionIds(host)).toHaveLength(14));
    expect(press(host, 'ArrowUp').defaultPrevented).toBe(true); // up from the first wraps to the last (Table)
    await vi.waitFor(() => expect(host.querySelector('[aria-selected=true]')?.id).toContain('table'));
    press(host, 'ArrowDown'); // back to the first
    press(host, 'ArrowDown'); // Heading 1
    await vi.waitFor(() => expect(host.querySelector('[aria-selected=true]')?.id).toContain('heading-1'));
    press(host, 'Enter');
    expect(t.view().state.doc.child(1).attrs['level']).toBe(1); // the second block, not the first
    expect(t.view().state.doc.child(0).attrs['level']).toBe(0);
    await vi.waitFor(() => expect(host.querySelector('[role=listbox]')).toBeNull());
    host.remove();
  });

  it('a click on a kind chooses it; Escape closes the menu and gives the focus back to the button; other keys are left alone', async () => {
    const { t, host } = await handleOnSecond();
    button(host).click();
    await vi.waitFor(() => expect(optionIds(host)).toHaveLength(14));
    expect(press(host, 'a').defaultPrevented).toBe(false);
    press(host, 'Escape');
    await vi.waitFor(() => expect(host.querySelector('[role=listbox]')).toBeNull());
    expect(press(host, 'Enter').defaultPrevented).toBe(false); // closed: the keys are not the menu's
    button(host).click();
    await vi.waitFor(() => expect(optionIds(host)).toHaveLength(14));
    host.querySelector('#block-handle-menu-option-quote')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector('[aria-selected=true]')?.id).toBe('block-handle-menu-option-quote')); // moving over a kind makes it the active one
    const quote = Array.from(host.querySelectorAll('[role=option]')).find((o) => o.textContent?.startsWith('Quote'))!;
    quote.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(t.view().state.doc.child(1).type.name).toBe('blockquote');
    host.remove();
  });

  it('does nothing when the pointer is over no block', async () => {
    const { t, host, setActive } = await handleOnSecond();
    setActive(false);
    button(host).click();
    await vi.waitFor(() => expect(optionIds(host)).toHaveLength(14));
    press(host, 'Enter');
    expect(t.view().state.doc.child(1).attrs['level']).toBe(0);
    host.remove();
  });
});
