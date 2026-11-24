import { TextSelection } from '@milkdown/prose/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { blockIdAt } from '../../src/editor/lock/block-id';
import { collabEditor, type CollabEditor } from './support';

let current: CollabEditor[] = [];
afterEach(async () => {
  await Promise.all(current.map((e) => e.destroy()));
  current = [];
});
const posOf = (t: CollabEditor, text: string): number => {
  let found = -1;
  t.view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text)) found = pos + 1;
  });
  return found;
};

describe('the id of the block a position is in', () => {
  it('is the Yjs element of that text block: one id per block, the same for every position in it, and none for a document that is not shared', async () => {
    const t = await collabEditor('First block.\n\nSecond block.\n\n- a list item\n');
    current.push(t);
    await vi.waitFor(() => expect(t.view().state.doc.childCount).toBeGreaterThan(2));
    const first = blockIdAt(t.view().state, posOf(t, 'First'));
    const firstAgain = blockIdAt(t.view().state, posOf(t, 'block.'));
    const second = blockIdAt(t.view().state, posOf(t, 'Second'));
    const item = blockIdAt(t.view().state, posOf(t, 'list item'));
    expect(first).toMatch(/^\d+:\d+$/);
    expect(firstAgain).toBe(first);
    expect(new Set([first, second, item]).size).toBe(3);
    // It is the element's own identity in the shared document.
    const fragment = t.doc.getXmlFragment('prosemirror');
    const element = fragment.get(1) as Y.XmlElement;
    const id = (element as unknown as { _item: { id: { client: number; clock: number } } })._item.id;
    expect(second).toBe(`${id.client}:${id.clock}`);
    // A list item's paragraph is found through the list and its item.
    const list = fragment.get(2) as Y.XmlElement;
    const paragraph = (list.get(0) as Y.XmlElement).get(0) as Y.XmlElement as unknown as { _item: { id: { client: number; clock: number } } };
    expect(item).toBe(`${paragraph._item.id.client}:${paragraph._item.id.clock}`);
  });

  it('is the same in another editor of the page: that is what lets one person see which block another is in', async () => {
    const a = await collabEditor('One.\n\nTwo.\n');
    current.push(a);
    await vi.waitFor(() => expect(a.view().state.doc.childCount).toBeGreaterThan(1));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc));
    const b = await collabEditor('', { doc });
    current.push(b);
    await vi.waitFor(() => expect(b.view().state.doc.textContent).toContain('Two.'));
    expect(blockIdAt(b.view().state, posOf(b, 'Two'))).toBe(blockIdAt(a.view().state, posOf(a, 'Two')));
    expect(blockIdAt(b.view().state, posOf(b, 'One'))).not.toBe(blockIdAt(b.view().state, posOf(b, 'Two')));
  });

  it('is null while the shared side is not made of blocks where the document says it is (a conversion is on its way), and does not throw', async () => {
    const t = await collabEditor('One.\n\nTwo.\n');
    current.push(t);
    await vi.waitFor(() => expect(t.view().state.doc.childCount).toBeGreaterThan(1));
    const fragment = t.doc.getXmlFragment('prosemirror');
    // The editor's document says: a list with one item, whose block is the paragraph; the shared one still has the paragraph itself, whose child is text.
    const list = t
      .view()
      .state.schema.nodes['bullet_list']!.create(null, t.view().state.schema.nodes['list_item']!.create(null, t.view().state.schema.nodes['paragraph']!.create(null, t.view().state.schema.text('Two.'))));
    const state = t.view().state.apply(t.view().state.tr.replaceWith(0, t.view().state.doc.content.size, [list]));
    expect(fragment.length).toBeGreaterThan(0);
    expect(blockIdAt(state, 4)).toBeNull();
  });

  it('is null where no shared document is bound, and where the element is not there yet', async () => {
    const t = await collabEditor('Only block.\n');
    current.push(t);
    await vi.waitFor(() => expect(t.view().state.doc.textContent).toContain('Only'));
    t.doc.getXmlFragment('prosemirror').delete(0, t.doc.getXmlFragment('prosemirror').length); // the shared side is ahead
    expect(blockIdAt(t.view().state, 2)).toBeNull();
    const view = t.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)));
  });
});
