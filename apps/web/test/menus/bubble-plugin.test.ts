import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainEditor } from './support';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
let current: Editor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});

const host = (t: Editor): HTMLElement => t.element.querySelector<HTMLElement>('.bubble-host')!;
const shown = (t: Editor): boolean => host(t)?.dataset['show'] === 'true';
const select = (t: Editor, from: number, to: number): void => {
  const view = t.view();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
};
const key = (t: Editor, init: KeyboardEventInit): void => void t.view().dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const button = (t: Editor, name: string): HTMLButtonElement => host(t).querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const field = (t: Editor): HTMLInputElement | null => host(t).querySelector<HTMLInputElement>('input');
const setValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

async function open(markdown = 'some words here'): Promise<Editor> {
  current = await plainEditor(markdown);
  select(current, 1, 5);
  await vi.waitFor(() => expect(shown(current!)).toBe(true));
  await vi.waitFor(() => expect(host(current!).querySelector('[role=toolbar]')).not.toBeNull()); // React draws it a moment after
  return current;
}

describe('the bubble in the editor', () => {
  it('opens over a selection of text with the formatting buttons, and closes when the selection is a point', async () => {
    const t = await open();
    expect(host(t).querySelector('[role=toolbar]')).not.toBeNull();
    select(t, 3, 3);
    await vi.waitFor(() => expect(shown(t)).toBe(false));
  });

  it('a button formats the selection, and shows the state of the selection afterwards', async () => {
    const t = await open();
    button(t, 'Bold').click();
    expect(t.markdown()).toContain('**some**');
    await vi.waitFor(() => expect(button(t, 'Bold').getAttribute('aria-pressed')).toBe('true'));
  });

  it('Mod-K opens the link editor; a refused address says why and keeps what was typed; an allowed one is applied and closes it', async () => {
    const t = await open();
    key(t, { key: 'k', ctrlKey: true });
    await vi.waitFor(() => expect(field(t)).not.toBeNull());
    setValue(field(t)!, 'javascript:alert(1)');
    host(t)
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host(t).querySelector('[role=alert]')?.textContent).toBe('Only web, mail and relative links are allowed'));
    expect(field(t)!.value).toBe('javascript:alert(1)');
    expect(t.markdown()).not.toContain('javascript');
    setValue(field(t)!, 'https://example.com');
    host(t)
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host(t).querySelector('[role=toolbar]')).not.toBeNull());
    expect(t.markdown()).toContain('[some](https://example.com)');
  });

  it('Cancel closes the link editor without a change; another selection closes it too', async () => {
    const t = await open();
    button(t, 'Link').click();
    await vi.waitFor(() => expect(field(t)).not.toBeNull());
    [...host(t).querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    await vi.waitFor(() => expect(field(t)).toBeNull());
    expect(t.markdown().trim()).toBe('some words here');
    await vi.waitFor(() => expect(button(t, 'Link')).not.toBeNull());
    button(t, 'Link').click();
    await vi.waitFor(() => expect(field(t)).not.toBeNull());
    select(t, 6, 11);
    await vi.waitFor(() => expect(field(t)).toBeNull());
  });

  it('is not for code, and not for an editor that cannot be edited; the key is left alone then', async () => {
    current = await plainEditor('```\ncode here\n```');
    const t = current;
    select(t, 2, 6);
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    t.view().dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(shown(t)).toBe(false);
  });
});
