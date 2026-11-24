import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { getMarkdown } from '@milkdown/utils';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';
import { uiPlugins } from '../../src/editor/core/plugins';
import '../support/dom';

/** The screen's own editor (the schema plugins and the screen's plugins) on a plain element, without a connection: for what the menus do to the document. */
export async function plainEditor(
  markdown: string,
  options: { editable?: boolean } = {},
): Promise<{ editor: Editor; element: HTMLElement; view: () => EditorView; markdown: () => string; cursorAtEnd: () => void; destroy: () => Promise<void> }> {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, element);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(grimoireEditorPlugins)
    .use(uiPlugins);
  await editor.create();
  const view = (): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));
  if (options.editable === false) view().setProps({ editable: () => false });
  return {
    editor,
    element,
    view,
    markdown: () => editor.action(getMarkdown()),
    cursorAtEnd: () => {
      const v = view();
      v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)));
      v.focus();
    },
    destroy: async () => {
      await editor.destroy(true);
      element.remove();
    },
  };
}
