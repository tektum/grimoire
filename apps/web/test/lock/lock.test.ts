import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_KINDS } from '../../src/editor/menus/blocks';
import { allowBlockChange } from '../../src/editor/lock';
import { blockIdAt } from '../../src/editor/lock/block-id';
import { LIMIT_TEXT, SOFT_LOCK_HELP } from '../../src/editor/lock/texts';
import { collabEditor, type CollabEditor } from './support';

const BOB = 'bbbbbbbb-0000-4000-8000-000000000001';
const LENA = 'eeeeeeee-0000-4000-8000-000000000002';
let current: CollabEditor | null = null;
afterEach(async () => {
  await current?.destroy();
  current = null;
});
const kind = (id: string) => BLOCK_KINDS.find((k) => k.id === id)!;
const posOf = (t: CollabEditor, text: string): number => {
  let found = -1;
  t.view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) found = pos + 1;
  });
  return found;
};
const notice = (t: CollabEditor): HTMLElement | null => t.element.querySelector<HTMLElement>('.lock-notice');
async function open(options: Parameters<typeof collabEditor>[1] = { names: { [BOB]: 'Bob' } }): Promise<CollabEditor> {
  current = await collabEditor('First block.\n\nSecond block.\n', options);
  await vi.waitFor(() => expect(current!.view().state.doc.textContent).toContain('Second'));
  return current;
}
const moveInto = (t: CollabEditor, text: string): number => {
  const pos = posOf(t, text);
  t.view().dispatch(t.view().state.tr.setSelection(TextSelection.create(t.view().state.doc, pos, pos)));
  return pos;
};

describe('publishing the block of the cursor', () => {
  it('puts the id of the block the cursor is in on the awareness, changes it with the cursor, and takes it back when the editor loses the focus', async () => {
    const t = await open();
    t.view().focus();
    const first = moveInto(t, 'First');
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBe(blockIdAt(t.view().state, first)));
    const second = moveInto(t, 'Second');
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBe(blockIdAt(t.view().state, second)), { timeout: 3000 });
    expect(blockIdAt(t.view().state, first)).not.toBe(blockIdAt(t.view().state, second));
    t.view().dom.blur();
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBeNull(), { timeout: 3000 });
    t.view().focus();
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBe(blockIdAt(t.view().state, second)), { timeout: 3000 });
  });

  it("holds no block while the editor has no focus, whatever comes into it: another person's edit does not publish the old block again", async () => {
    const t = await open();
    t.view().focus();
    const second = moveInto(t, 'Second');
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBe(blockIdAt(t.view().state, second)), { timeout: 3000 });
    t.view().dom.blur();
    await vi.waitFor(() => expect(t.awareness.getLocalState()?.['blockId']).toBeNull(), { timeout: 3000 });
    t.view().dispatch(t.view().state.tr.insertText('x', 2)); // what y-prosemirror does when another person types
    expect(t.view().hasFocus()).toBe(false);
    expect(t.awareness.getLocalState()?.['blockId']).toBeNull();
  });
});

describe('the soft lock', () => {
  it('refuses a conversion that recreates the block while another person is in it, and says who, with their directory name', async () => {
    const t = await open();
    const pos = moveInto(t, 'Second');
    t.remote(101, BOB, blockIdAt(t.view().state, pos));
    await vi.waitFor(() => expect(t.awareness.getStates().has(101)).toBe(true));
    for (const id of ['bullet-list', 'numbered-list', 'task-list', 'quote', 'code']) expect(allowBlockChange(t.ctx, kind(id), pos), id).toBe(false);
    await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Bob is editing this block'));
    expect(notice(t)?.getAttribute('role')).toBe('alert');
  });

  it('does not refuse what concurrent typing survives (a heading level, a divider, a table), nor a block another person is not in, nor one only the same person is in', async () => {
    const t = await open();
    const pos = moveInto(t, 'Second');
    const blockId = blockIdAt(t.view().state, pos);
    t.remote(101, BOB, blockId);
    for (const id of ['text', 'heading-2', 'divider', 'table']) expect(allowBlockChange(t.ctx, kind(id), pos), id).toBe(true);
    t.remote(101, BOB, blockIdAt(t.view().state, posOf(t, 'First'))); // Bob is in the other block
    expect(allowBlockChange(t.ctx, kind('bullet-list'), pos)).toBe(true);
    t.remote(102, 'me', blockId); // the same person in another tab
    expect(allowBlockChange(t.ctx, kind('bullet-list'), pos)).toBe(true);
    t.awareness.states.set(103, { user: 'not an object', blockId });
    t.awareness.states.set(104, { blockId });
    expect(allowBlockChange(t.ctx, kind('bullet-list'), pos)).toBe(true); // a state with no user id holds nothing
  });

  it('works again as soon as the other person has left the block, and the message goes', async () => {
    const t = await open();
    const pos = moveInto(t, 'Second');
    t.remote(101, BOB, blockIdAt(t.view().state, pos));
    expect(allowBlockChange(t.ctx, kind('quote'), pos)).toBe(false);
    await vi.waitFor(() => expect(notice(t)).not.toBeNull());
    t.awareness.states.delete(101);
    expect(allowBlockChange(t.ctx, kind('quote'), pos)).toBe(true);
    await vi.waitFor(() => expect(t.element.querySelector<HTMLElement>('.lock-notice-host')?.dataset['show']).toBe('false'));
  });

  it('says "Someone" for a person the directory does not know yet, and the name once it does', async () => {
    const t = await open({ names: { [LENA]: 'Lena' } });
    const pos = moveInto(t, 'Second');
    t.awareness.states.set(105, { user: { id: LENA }, blockId: blockIdAt(t.view().state, pos) });
    expect(allowBlockChange(t.ctx, kind('quote'), pos)).toBe(false);
    await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Lena is editing this block'));
  });

  it('a name that comes late updates the message it was asked for and no other; a newer refusal, Close and the editor going end the wait', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = await open({
      names: { [BOB]: 'Bob' },
      fetchNames: async (ids) => {
        if (ids.includes(LENA)) await gate;
        return ids.map((id) => ({ id, name: id === LENA ? 'Lena' : 'Bob' }));
      },
    });
    t.directory.request([BOB]); // Bob's name is known before the refusals; Lena's comes when the gate is let go
    await vi.waitFor(() => expect(t.directory.nameOf(BOB)).toBe('Bob'));
    const subscribed: Array<() => boolean> = [];
    const original = t.directory.subscribe.bind(t.directory);
    t.directory.subscribe = (listener) => {
      const stop = original(listener);
      let live = true;
      subscribed.push(() => live);
      return () => {
        live = false;
        stop();
      };
    };
    const first = moveInto(t, 'First');
    const second = moveInto(t, 'Second');
    t.awareness.states.set(105, { user: { id: LENA }, blockId: blockIdAt(t.view().state, first) });
    t.awareness.states.set(106, { user: { id: BOB }, blockId: blockIdAt(t.view().state, second) });
    expect(allowBlockChange(t.ctx, kind('quote'), first)).toBe(false); // Lena's name is not known: "Someone"
    expect(allowBlockChange(t.ctx, kind('quote'), second)).toBe(false); // a newer refusal, for Bob, ends the first wait
    await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Bob is editing this block'));
    expect(subscribed.map((live) => live())).toEqual([false]);
    release();
    await vi.waitFor(() => expect(t.directory.nameOf(LENA)).toBe('Lena')); // her name has come, and the listeners have run
    expect(notice(t)?.querySelector('.lock-message')?.textContent).toBe('Bob is editing this block'); // Lena's name did not take its place
  });

  it('the "Why?" opens the help: what the lock protects (R3.15) and the limits of editing together, in their exact words; Close and Escape close the message', async () => {
    const t = await open();
    const pos = moveInto(t, 'Second');
    t.remote(101, BOB, blockIdAt(t.view().state, pos));
    allowBlockChange(t.ctx, kind('quote'), pos);
    await vi.waitFor(() => expect(notice(t)).not.toBeNull());
    const why = [...notice(t)!.querySelectorAll('button')].find((b) => b.textContent === 'Why?')!;
    expect(why.getAttribute('aria-expanded')).toBe('false');
    why.click();
    await vi.waitFor(() => expect(notice(t)?.querySelector('.lock-help')).not.toBeNull());
    const paragraphs = [...notice(t)!.querySelectorAll('.lock-help p')].map((p) => p.textContent);
    expect(paragraphs).toEqual([SOFT_LOCK_HELP, LIMIT_TEXT]);
    expect(LIMIT_TEXT).toContain('splitting it, joining it with the one above, or turning it into a list');
    expect(LIMIT_TEXT).toContain('planned after the first version');
    expect(LIMIT_TEXT).toContain('Holding back Enter, Backspace and list changes while someone else is in the paragraph, and offering to keep a copy automatically, are planned after the first version.');
    expect(LIMIT_TEXT).not.toContain('structure lock'); // the owner's answer (Q86): said plainly
    expect(LIMIT_TEXT).toContain('their letters can end up mixed together');
    [...notice(t)!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!.click();
    await vi.waitFor(() => expect(t.element.querySelector<HTMLElement>('.lock-notice-host')?.dataset['show']).toBe('false'));
    allowBlockChange(t.ctx, kind('quote'), pos);
    await vi.waitFor(() => expect(notice(t)).not.toBeNull());
    notice(t)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(t.element.querySelector<HTMLElement>('.lock-notice-host')?.dataset['show']).toBe('false'));
  });
});
