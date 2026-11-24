import { afterEach, describe, expect, it, vi } from 'vitest';
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
