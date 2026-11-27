import { NodeSelection, TextSelection } from '@milkdown/prose/state';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_KINDS, SLASH_KINDS } from '../../src/editor/menus/blocks';
import { BlockHandle } from '../../src/editor/menus/BlockHandle';
import { BUBBLE_DELAY } from '../../src/editor/menus/bubble';
import { blockAtSelection, hideWhileTyping } from '../../src/editor/menus/handle';
import { SlashMenu } from '../../src/editor/menus/SlashMenu';
import { plainEditor } from './support';
import '../support/dom';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
let current: Editor | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await current?.destroy();
  current = null;
});

const select = (t: Editor, from: number, to: number): void => {
  const view = t.view();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
};
const bubbleShown = (t: Editor): boolean => t.element.querySelector<HTMLElement>('.bubble-host')?.dataset['show'] === 'true';
const handleShown = (t: Editor): boolean => t.element.querySelector<HTMLElement>('.block-handle')?.dataset['show'] === 'true';
const press = (target: EventTarget, type: string): void => void target.dispatchEvent(new Event(type, { bubbles: true }));
const key = (target: EventTarget, init: KeyboardEventInit): void => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('the selection bubble after a press', () => {
  it('waits while the pointer is pressed, and comes 120ms after it is released', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(t.view().dom, 'pointerdown');
    select(t, 1, 5); // the drag
    await vi.advanceTimersByTimeAsync(500);
    expect(bubbleShown(t)).toBe(false);
    press(document, 'pointerup');
    await vi.advanceTimersByTimeAsync(BUBBLE_DELAY - 1);
    expect(bubbleShown(t)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(bubbleShown(t)).toBe(true);
  });

  it('a new press before the moment puts the bar off until that press is released', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(t.view().dom, 'pointerdown');
    select(t, 1, 5);
    press(document, 'pointerup');
    await vi.advanceTimersByTimeAsync(60);
    press(t.view().dom, 'pointerdown');
    await vi.advanceTimersByTimeAsync(500);
    expect(bubbleShown(t)).toBe(false);
    press(document, 'pointerup');
    await vi.advanceTimersByTimeAsync(BUBBLE_DELAY + 20);
    expect(bubbleShown(t)).toBe(true);
  });

  it('a native drag that ends with no pointer event (dragend) releases the press too', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(t.view().dom, 'pointerdown');
    press(document, 'dragend');
    await vi.advanceTimersByTimeAsync(BUBBLE_DELAY + 20);
    select(t, 1, 5);
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleShown(t)).toBe(true);
  });

  it('a press that is cancelled (a touch that became a scroll or a native drag) does not leave the bar suppressed', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(t.view().dom, 'pointerdown');
    press(document, 'pointercancel');
    await vi.advanceTimersByTimeAsync(BUBBLE_DELAY + 20);
    select(t, 1, 5); // a later selection made with keys
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleShown(t)).toBe(true);
  });

  it('a press that ends with the window losing focus does not either', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(t.view().dom, 'pointerdown');
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(BUBBLE_DELAY + 20);
    select(t, 1, 5);
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleShown(t)).toBe(true);
  });

  it('a release of a press made outside the text changes nothing', async () => {
    current = await plainEditor('some words here');
    const t = current;
    vi.useFakeTimers();
    press(document, 'pointerup');
    select(t, 1, 5); // made with keys: no press to wait for
    await vi.advanceTimersByTimeAsync(10);
    expect(bubbleShown(t)).toBe(true);
  });
});

describe('the block handle while keys are going', () => {
  it('a key that types marks the root, a pointer movement or a caret key clears it; shortcuts and other keys do not mark it', () => {
    const root = document.createElement('div');
    const editor = document.createElement('div');
    root.append(editor);
    document.body.append(root);
    const stop = hideWhileTyping(root, editor);
    key(editor, { key: 'Shift' });
    key(editor, { key: 'k', ctrlKey: true });
    key(editor, { key: 'k', metaKey: true });
    key(editor, { key: 'k', altKey: true });
    expect(root.dataset['typing']).toBeUndefined();
    key(editor, { key: 'a' });
    expect(root.dataset['typing']).toBe('true');
    press(document, 'pointermove');
    expect(root.dataset['typing']).toBeUndefined();
    key(editor, { key: ' ' });
    expect(root.dataset['typing']).toBe('true');
    key(editor, { key: 'ArrowDown' });
    expect(root.dataset['typing']).toBeUndefined();
    key(editor, { key: 'b' });
    stop();
    expect(root.dataset['typing']).toBeUndefined();
    key(editor, { key: 'c' });
    expect(root.dataset['typing']).toBeUndefined();
    root.remove();
  });

  it('in the editor, the root around the text carries the mark', async () => {
    current = await plainEditor('one\n\ntwo');
    key(current.view().dom, { key: 'x' });
    expect(current.view().dom.parentElement!.dataset['typing']).toBe('true');
  });

  it('a caret key shows the handle beside the block the caret is in; not where the editor cannot be edited', async () => {
    current = await plainEditor('one\n\ntwo');
    const t = current;
    expect(handleShown(t)).toBe(false);
    key(t.view().dom, { key: 'ArrowDown' });
    select(t, 6, 6);
    await vi.waitFor(() => expect(handleShown(t)).toBe(true));
    await t.destroy();
    current = await plainEditor('one\n\ntwo', { editable: false });
    const locked = current;
    key(locked.view().dom, { key: 'ArrowDown' });
    select(locked, 6, 6);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handleShown(locked)).toBe(false);
  });

  it('a caret key with a whole divider selected shows nothing: the selection is not in a block', async () => {
    current = await plainEditor('one\n\n---\n\ntwo');
    const t = current;
    const view = t.view();
    let hr = -1;
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'hr') hr = offset;
    });
    key(view.dom, { key: 'ArrowDown' });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hr)));
    expect(blockAtSelection(view)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handleShown(t)).toBe(false);
  });
});

describe('the look of the menus', () => {
  it('the handle is a button named "Block menu" with the same tooltip', () => {
    render(<BlockHandle open={false} kinds={BLOCK_KINDS} active={0} onToggle={() => undefined} onPick={() => undefined} onHover={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Block menu' }).getAttribute('title')).toBe('Block menu');
  });

  it('the slash menu shows the Markdown shortcut beside an item as decoration, keeps the names, and has no footer of key hints', () => {
    const { container } = render(<SlashMenu kinds={SLASH_KINDS} active={0} onPick={() => undefined} onHover={() => undefined} />);
    const heading = screen.getByRole('option', { name: /Heading 2/ });
    const shortcut = heading.querySelector('.slash-shortcut')!;
    expect(shortcut.textContent).toBe('##');
    expect(shortcut.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('option', { name: /Quote/ }).querySelector('.slash-shortcut')!.textContent).toBe('>');
    expect(screen.getByRole('option', { name: /^Text/ }).querySelector('.slash-shortcut')).toBeNull();
    expect(screen.getByRole('option', { name: /Table/ }).querySelector('.slash-shortcut')).toBeNull();
    const list = screen.getByRole('listbox');
    expect(container.firstElementChild).toBe(list);
    expect([...list.children].every((child) => child.getAttribute('role') === 'option')).toBe(true);
    expect(container.querySelector('kbd, footer, .slash-foot')).toBeNull();
  });

  it('every row has an icon that is decoration only, and the Code block row keeps its name and its fence shortcut', () => {
    render(<SlashMenu kinds={SLASH_KINDS} active={0} onPick={() => undefined} onHover={() => undefined} />);
    for (const row of screen.getAllByRole('option')) {
      const icon = row.querySelector('svg.slash-icon');
      expect(icon, row.textContent ?? '').not.toBeNull();
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
    }
    const code = screen.getByRole('option', { name: /^Code block/ });
    expect(code.querySelector('.slash-shortcut')!.textContent).toBe('```');
  });
});
