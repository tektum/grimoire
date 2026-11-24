import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockIdAt } from '../../src/editor/lock/block-id';
import { createHandleHost } from '../../src/editor/menus/handle';
import { collabEditor, type CollabEditor } from './support';

const BOB = 'bbbbbbbb-0000-4000-8000-000000000001';
let current: CollabEditor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});
const posOf = (t: CollabEditor, text: string): number => {
  let found = -1;
  t.view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) found = pos + 1;
  });
  return found;
};
const notice = (t: CollabEditor): HTMLElement | null => t.element.querySelector<HTMLElement>('.lock-notice');
async function open(): Promise<CollabEditor> {
  current = await collabEditor('First block.\n\nSecond block.\n', { names: { [BOB]: 'Bob' } });
  await vi.waitFor(() => expect(current!.view().state.doc.textContent).toContain('Second'));
  return current;
}
const moveInto = (t: CollabEditor, text: string): number => {
  const pos = posOf(t, text);
  t.view().dispatch(t.view().state.tr.setSelection(TextSelection.create(t.view().state.doc, pos, pos)));
  return pos;
};

describe('the lock in the menus', () => {
  it('the slash menu leaves the block unchanged and puts the typed text back; a heading from it is not refused', async () => {
    const t = await open();
    const view = t.view();
    const pos = moveInto(t, 'Second');
    const start = view.state.selection.$from.start();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start))); // the start of the paragraph
    view.dispatch(view.state.tr.insertText('/bullet', start));
    await vi.waitFor(() => expect(t.element.querySelector('.slash-host')?.getAttribute('data-show')).toBe('true'), { timeout: 3000 });
    t.remote(101, BOB, blockIdAt(view.state, pos)); // Bob is in the block (after the menu is up: the awareness is read when a kind is chosen)
    await vi.waitFor(() => expect(t.element.querySelectorAll('[role=option]')).toHaveLength(1), { timeout: 3000 }); // "bullet": the bulleted list
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(view.state.doc.child(1).type.name).toBe('paragraph'); // not a list
    expect(view.state.doc.child(1).textContent).toContain('/bulletSecond block.');
    await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Bob is editing this block'));
  });

  it('the handle menu: refused while Bob is in the block, the block unchanged; after he moves away the same action works', async () => {
    const t = await open();
    const secondStart = t.view().state.doc.child(0).nodeSize;
    const hovered = t.view().dom.children[1] as HTMLElement; // the element the pointer is over, as the library has it
    const { host } = createHandleHost(t.ctx, () => ({ el: hovered }));
    document.body.append(host);
    try {
      t.remote(101, BOB, blockIdAt(t.view().state, secondStart + 1));
      const choose = async (label: RegExp): Promise<void> => {
        host.querySelector<HTMLButtonElement>('button.block-handle-button')!.click();
        await vi.waitFor(() => expect(host.querySelectorAll('[role=option]')).toHaveLength(14));
        [...host.querySelectorAll('[role=option]')].find((o) => label.test(o.textContent ?? ''))!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      };
      await choose(/^Bulleted list/);
      expect(t.view().state.doc.child(1).type.name).toBe('paragraph');
      await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Bob is editing this block'));
      t.awareness.states.delete(101); // Bob moves away
      await choose(/^Bulleted list/);
      expect(t.view().state.doc.child(1).type.name).toBe('bullet_list');
    } finally {
      host.remove();
    }
  });
});
