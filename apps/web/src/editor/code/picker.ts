import type { Node } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import { LANGUAGES } from './languages';

/** Makes the select show `language`: plain text for none, a list entry for the fixed ones, and its own entry for a language that is not in the list (kept, never changed by looking). */
function show(select: HTMLSelectElement, language: string): void {
  // The entry of an unlisted language that is no longer the one shown goes: the select is reused for other blocks and for a peer's changes.
  for (const extra of Array.from(select.querySelectorAll<HTMLOptionElement>('option[data-extra]'))) if (extra.value !== language) extra.remove();
  if (language !== '' && !Array.from(select.options).some((option) => option.value === language)) {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    option.dataset['extra'] = '';
    select.append(option);
  }
  if (select.value !== language) select.value = language;
}

/** The code block the cursor is in: its place and the depth it is at, or null. */
function blockOfCursor(state: EditorState): { pos: number; depth: number; node: Node } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'code_block') return { pos: $from.before(depth), depth, node: $from.node(depth) };
  }
  return null;
}

const languageOf = (node: Node): string => (typeof node.attrs['language'] === 'string' ? node.attrs['language'] : '');

/** The bar with the select: plain text, the fixed list. */
function build(view: EditorView): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'code-language-bar';
  bar.contentEditable = 'false';
  const text = document.createElement('span');
  text.setAttribute('aria-hidden', 'true');
  text.textContent = 'Language';
  const select = document.createElement('select');
  select.className = 'code-language';
  select.setAttribute('aria-label', 'Language of this code block');
  for (const [name, label] of [['', 'Plain text'], ...LANGUAGES] as const) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = label;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const block = blockOfCursor(view.state);
    if (block === null) return;
    view.dispatch(view.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, language: select.value }));
  });
  bar.append(text, select);
  return bar;
}

/** The select shows the language of the block the cursor is in (a peer may have changed it): a language that is not in the list gets its own entry, kept as it is. */
function syncSelect(view: EditorView): void {
  const block = blockOfCursor(view.state);
  const select = view.dom.parentElement?.querySelector<HTMLSelectElement>('select.code-language') ?? view.dom.querySelector<HTMLSelectElement>('select.code-language');
  if (block === null || select === null) return;
  show(select, languageOf(block.node));
}

/**
 * A select for the language of the code block the cursor is in (R11.6), right after the block, while the editor can be edited. It is a widget outside the block, so the
 * block's own DOM is not redrawn when the language changes and the select keeps the focus (and a person typing in it is not interrupted). The document's text and the schema
 * are unchanged: only the \`language\` attribute the fence is written with.
 */
export const codeLanguage = $prose(() => {
  let current: EditorView | null = null;
  return new Plugin({
    key: new PluginKey('grimoire-code-language'),
    view: (view) => {
      current = view;
      // The first drawing happens before the view is known (and so before it is known whether it can be edited): draw once more, a moment later, with that known.
      queueMicrotask(() => {
        if (current === view && !view.isDestroyed) view.dispatch(view.state.tr);
      });
      return { update: syncSelect, destroy: () => { current = null; } };
    },
    props: {
      decorations: (state) => {
        if (current === null || !current.editable) return null; // not known yet, or not editable: no select
        const block = blockOfCursor(state);
        if (block === null) return null;
        const view = current;
        return DecorationSet.create(state.doc, [Decoration.widget(block.pos + block.node.nodeSize, () => build(view), { key: 'code-language', side: -1, ignoreSelection: true, stopEvent: () => true })]);
      },
    },
  });
});
