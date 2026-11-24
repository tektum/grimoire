import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx, serializerCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';

export interface Harness {
  readonly editor: Editor;
  readonly view: EditorView;
  readonly root: HTMLElement;
  /** The document as Markdown, as the page would save it. */
  markdown(): string;
  /** Puts the cursor in the cell at (row, column) of the first table, or at the start of the document when there is no such cell. */
  cursorInCell(row: number, column: number): void;
  cursorAtStart(): void;
  destroy(): Promise<void>;
}

/** A real editor on `markdown` with the shared schema plus `extra`, in the test DOM. */
export async function makeEditor(markdown: string, extra: MilkdownPlugin | MilkdownPlugin[], options: { editable?: boolean } = {}): Promise<Harness> {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => options.editable !== false }));
    })
    .use(grimoireEditorPlugins)
    .use(extra);
  await editor.create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const select = (pos: number): void => { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos)))); };
  return {
    editor,
    view,
    root,
    markdown: () => editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc)),
    cursorInCell(row, column) {
      let found = -1;
      let seen = -1;
      view.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        const isRow = /^table(_header)?_row$/.test(node.type.name);
        if (isRow) seen += 1;
        if (isRow && seen === row) {
          node.forEach((cell, offset, index) => {
            if (index === column) found = pos + 1 + offset + 1;
          });
        }
        return true;
      });
      select(found >= 0 ? found : 1);
    },
    cursorAtStart: () => { select(1); },
    destroy: async () => {
      await editor.destroy(true);
      root.remove();
    },
  };
}

export const TABLE_2X2 = '| a | b |\n| - | - |\n| 1 | 2 |\n';
