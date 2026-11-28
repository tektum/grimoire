import { type CmdKey, commandsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { addColAfterCommand, addColBeforeCommand, addRowAfterCommand, addRowBeforeCommand } from '@milkdown/preset-gfm';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import { deleteColumn, deleteRow, isInTable, selectedRect } from '@milkdown/prose/tables';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

interface Action {
  readonly name: string;
  readonly label: string;
  readonly run: (ctx: Ctx, view: EditorView) => void;
  /** When the control does not apply (it is shown off). */
  readonly off?: (place: Place) => boolean;
}

interface Place {
  readonly at: number;
  readonly inHeader: boolean;
  /** Deleting the selected rows would leave no row under the header: a table keeps at least one. */
  readonly lastBodyRow: boolean;
}

const call = (ctx: Ctx, key: CmdKey<unknown>): void => { ctx.get(commandsCtx).call(key); };

/** The controls of a table, in the order they are shown. The adding ones are the GFM preset's commands; the deleting ones are the table library's. */
const ACTIONS: readonly Action[] = [
  { name: 'Add row above', label: 'Row above', off: (p) => p.inHeader, run: (ctx) => { call(ctx, addRowBeforeCommand.key); } },
  { name: 'Add row below', label: 'Row below', run: (ctx) => { call(ctx, addRowAfterCommand.key); } },
  { name: 'Add column left', label: 'Column left', run: (ctx) => { call(ctx, addColBeforeCommand.key); } },
  { name: 'Add column right', label: 'Column right', run: (ctx) => { call(ctx, addColAfterCommand.key); } },
  { name: 'Delete row', label: 'Delete row', off: (p) => p.inHeader || p.lastBodyRow, run: (_ctx, view) => { deleteRow(view.state, view.dispatch); } },
  { name: 'Delete column', label: 'Delete column', run: (_ctx, view) => { deleteColumn(view.state, view.dispatch); } },
];

/** The cell (or header cell) the cursor is in, as the range to mark. */
function activeCell(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'table_cell' || name === 'table_header') return { from: $from.before(depth), to: $from.after(depth) };
  }
  return null;
}

/** Where the controls go and which of them apply: just after the table the cursor is in, or null when it is not in one. */
function placeFor(state: EditorState): Place | null {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  return { at: rect.tableStart - 1 + rect.table.nodeSize, inHeader: rect.top === 0, lastBodyRow: rect.map.height - (rect.bottom - rect.top) < 2 };
}

/**
 * The controls of a table (R11.6): a toolbar right after the table the cursor is in, while the editor can be edited. It is drawn as a widget in the document, so it is
 * the next thing in the Tab order after the table, and a mouse press on a button does not take the focus from the cursor. No schema change.
 */
export const tableToolbar = $prose((ctx) => {
  let current: EditorView | null = null;
  const build = (place: Place) => (): HTMLElement => {
    const bar = document.createElement('div');
    bar.className = 'table-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Table controls');
    bar.contentEditable = 'false';
    for (const action of ACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.setAttribute('aria-label', action.name);
      button.disabled = action.off?.(place) === true;
      // The cursor stays where it is: a press does not move the focus to the button (the keyboard can still reach and press it).
      button.addEventListener('mousedown', (event) => { event.preventDefault(); });
      button.addEventListener('click', () => {
        if (current !== null) action.run(ctx, current);
      });
      bar.append(button);
    }
    return bar;
  };
  return new Plugin({
    key: new PluginKey('grimoire-table-toolbar'),
    view: (view) => {
      current = view;
      return { destroy: () => { current = null; } };
    },
    props: {
      /**
       * A table is drawn inside a box that scrolls sideways on its own, so a wide table never makes the page pan on a phone. The box is a node view, so ProseMirror owns it: a
       * wrapper added from outside the view would be a foreign mutation it reads back and forth (the fuzz found that as an out-of-memory).
       */
      nodeViews: {
        table: () => {
          const box = document.createElement('div');
          box.className = 'table-scroll';
          const table = document.createElement('table');
          box.append(table);
          return { dom: box, contentDOM: table };
        },
      },
      decorations: (state) => {
        const place = current === null || current.editable ? placeFor(state) : null;
        // The key says which kind of toolbar it is, so the controls are drawn again (on or off) when the cursor or the table's size changes what applies.
        const cell = place === null ? null : activeCell(state);
        return place === null
          ? null
          : DecorationSet.create(state.doc, [
              ...(cell === null ? [] : [Decoration.node(cell.from, cell.to, { class: 'table-cell-active' })]),
              Decoration.widget(place.at, build(place), { key: `table-toolbar-${place.inHeader ? 'header' : 'body'}-${place.lastBodyRow ? 'last' : 'more'}`, side: 1, stopEvent: () => true, ignoreSelection: true }),
            ]);
      },
    },
  });
});
