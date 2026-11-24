import { htmlSchema } from '@milkdown/preset-commonmark';
import { $view } from '@milkdown/utils';
import type { Node as ProseNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';

/**
 * Raw HTML written in a page is shown as inert text, never as markup: the node's own text goes into a quiet, non-editable block
 * (`textContent`, so nothing in it is ever parsed) with an "Edit source" button. The button turns the block into ordinary text of the
 * page, which the person can then edit; nothing in the schema changes. In a view that cannot be edited the button is hidden by the style sheet.
 */
export function rawHtmlView(node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('span');
  dom.className = 'raw-html';
  dom.setAttribute('data-type', 'html');
  dom.setAttribute('data-value', String(node.attrs['value'] ?? ''));
  dom.contentEditable = 'false';

  const code = document.createElement('code');
  code.className = 'raw-html-text';
  code.textContent = String(node.attrs['value'] ?? '');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'raw-html-edit';
  button.textContent = 'Edit source';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const at = getPos();
    const value = String(node.attrs['value'] ?? '');
    if (at === undefined || !view.editable || value === '') return;
    view.dispatch(view.state.tr.replaceWith(at, at + node.nodeSize, view.state.schema.text(value)));
    view.focus();
  });

  dom.append(code, button);
  return {
    dom,
    // The block is not editable and holds no editable content: ProseMirror leaves its events and its own DOM changes alone.
    stopEvent: () => true,
    ignoreMutation: () => true,
  };
}

/** The Milkdown plugin that puts the view on the `html` node. */
export const rawHtmlPlugin = $view(htmlSchema.node, () => rawHtmlView);
