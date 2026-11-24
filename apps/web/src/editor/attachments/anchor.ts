import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

const key = new PluginKey<ReadonlyMap<symbol, number>>('attachment-anchors');

/**
 * Places in the document that follow the text as it changes: the place where the person chose "Image or file" is kept here while the files upload, so they land there
 * and not wherever the cursor has gone by then (a paste has its widget for the same purpose).
 */
export const anchorPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: () => new Map<symbol, number>(),
        apply(tr, anchors) {
          const mapped = new Map<symbol, number>();
          for (const [id, pos] of anchors) mapped.set(id, tr.mapping.map(pos));
          const meta = tr.getMeta(key) as { add?: { id: symbol; pos: number }; remove?: symbol } | undefined;
          if (meta?.add !== undefined) mapped.set(meta.add.id, meta.add.pos);
          if (meta?.remove !== undefined) mapped.delete(meta.remove);
          return mapped;
        },
      },
    }),
);

export function addAnchor(view: EditorView, pos: number): symbol {
  const id = Symbol('anchor');
  view.dispatch(view.state.tr.setMeta(key, { add: { id, pos } }));
  return id;
}

export const anchorPosition = (view: EditorView, id: symbol): number | undefined => key.getState(view.state)?.get(id);

export function dropAnchor(view: EditorView, id: symbol): void {
  view.dispatch(view.state.tr.setMeta(key, { remove: id }));
}
