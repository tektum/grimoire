import type { EditorState } from '@milkdown/prose/state';
import { ySyncPluginKey } from 'y-prosemirror';
import type * as Y from 'yjs';

/**
 * The stable id of the block (the text block) the position is in: the identity of its Yjs element, `client:clock`, which every connected editor of the page sees the same
 * (R3.17). The document is walked in step with the shared one: the element children of a block container are its block children, so the n-th block child of the editor's
 * document is the n-th element of the shared one. Null where no shared document is bound, or the two do not line up (a change is on its way).
 */
export function blockIdAt(state: EditorState, pos: number): string | null {
  const shared = (ySyncPluginKey.getState(state) as { type?: Y.XmlFragment } | undefined)?.type;
  if (shared === undefined) return null;
  const $pos = state.doc.resolve(pos);
  let element: Y.XmlFragment | Y.XmlElement | Y.XmlText | undefined = shared;
  for (let depth = 0; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).isTextblock) break;
    if (!('get' in element) || typeof element.get !== 'function') return null; // the shared side is not made of blocks here: a change is on its way
    const next: unknown = element.get($pos.index(depth));
    if (next === undefined || next === null || typeof next !== 'object' || !('_item' in next)) return null;
    element = next as Y.XmlElement;
  }
  const item = (element as unknown as { _item: { id: { client: number; clock: number } } | null })._item;
  return item === null || item === undefined ? null : `${item.id.client}:${item.id.clock}`;
}
