import { commandsCtx, editorViewCtx, type CmdKey } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { createCodeBlockCommand, insertHrCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand } from '@milkdown/preset-commonmark';
import { insertTableCommand } from '@milkdown/preset-gfm';
import { setBlockLevelCommand } from '@tektum/grimoire-editor-schema';
import { chooseFiles } from '../attachments';

/** One kind of block the person can turn the current block into, from the slash menu (and later the block handle). */
export interface BlockKind {
  readonly id: string;
  /** The accessible name and the visible text of the item. */
  readonly label: string;
  /** One line under the label. */
  readonly description: string;
  /** Other words that find it: the query is matched against these and the label. */
  readonly keywords: readonly string[];
  /** Whether it recreates the block (a list, a quote, a code block): then the soft lock refuses it while another person's cursor is in the block. A level change or an insertion does not. */
  readonly structural?: boolean;
  /** Does it. False when the schema does not allow it where the cursor is (the editor is left as it was). */
  run(ctx: Ctx): boolean;
}

const call = <T>(ctx: Ctx, key: CmdKey<T>, payload?: T): boolean => ctx.get(commandsCtx).call(key, payload);

const level = (n: number): BlockKind => ({
  id: n === 0 ? 'text' : `heading-${n}`,
  label: n === 0 ? 'Text' : `Heading ${n}`,
  description: n === 0 ? 'Plain paragraph' : (['', 'Large section title', 'Section title', 'Subsection title', 'Small title', 'Smaller title', 'Smallest title'][n] ?? ''),
  keywords: n === 0 ? ['paragraph', 'plain', 'normal'] : ['heading', 'title', `h${n}`, String(n)],
  run: (ctx) => call(ctx, setBlockLevelCommand.key, n),
});

/** A bullet list whose first item is an unchecked task: the list, then the item's `checked` attribute. */
function wrapInTaskList(ctx: Ctx): boolean {
  if (!call(ctx, wrapInBulletListCommand.key)) return false;
  const view = ctx.get(editorViewCtx);
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== 'list_item') continue;
    view.dispatch(view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: false }));
    break;
  }
  return true;
}

/**
 * The block kinds of the schema, in the order the menu shows them: text, the six heading levels, the three lists, quote, code, divider, table.
 * Then the file chooser: images and any file, uploaded to the page. (The table's own controls are the table task's.)
 */
export const BLOCK_KINDS: readonly BlockKind[] = [
  level(0),
  ...[1, 2, 3, 4, 5, 6].map(level),
  { id: 'bullet-list', label: 'Bulleted list', description: 'A list with bullets', keywords: ['bullet', 'list', 'unordered', 'ul'], structural: true, run: (ctx) => call(ctx, wrapInBulletListCommand.key) },
  { id: 'numbered-list', label: 'Numbered list', description: 'A list with numbers', keywords: ['number', 'ordered', 'list', 'ol'], structural: true, run: (ctx) => call(ctx, wrapInOrderedListCommand.key) },
  { id: 'task-list', label: 'Task list', description: 'A list with check boxes', keywords: ['task', 'todo', 'check', 'checkbox', 'list'], structural: true, run: wrapInTaskList },
  { id: 'quote', label: 'Quote', description: 'Set text apart as a quotation', keywords: ['quote', 'blockquote', 'cite'], structural: true, run: (ctx) => call(ctx, wrapInBlockquoteCommand.key) },
  { id: 'code', label: 'Code block', description: 'Text in a fixed-width font', keywords: ['code', 'fence', 'pre', 'snippet'], structural: true, run: (ctx) => call(ctx, createCodeBlockCommand.key) },
  { id: 'divider', label: 'Divider', description: 'A horizontal line', keywords: ['divider', 'rule', 'line', 'hr', 'separator'], run: (ctx) => call(ctx, insertHrCommand.key) },
  { id: 'table', label: 'Table', description: 'Rows and columns', keywords: ['table', 'grid', 'rows', 'columns'], run: (ctx) => call(ctx, insertTableCommand.key, { row: 3, col: 3 }) },
  { id: 'file', label: 'Image or file', description: 'Upload from your computer', keywords: ['image', 'picture', 'photo', 'file', 'upload', 'attachment', 'attach'], run: (ctx) => { void chooseFiles(ctx); return true; } },
];

/**
 * The kinds that match what was typed after the slash: every kind for nothing, else those with the text (any case) in the label or a keyword, in four groups: the label
 * starts with it, a keyword starts with it, the label has it inside, a keyword has it inside. (So `/c` offers the code block before the task list, whose keyword "check" starts with c.)
 */
export function matchingKinds(query: string, kinds: readonly BlockKind[] = BLOCK_KINDS): readonly BlockKind[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return kinds;
  const groups: BlockKind[][] = [[], [], [], []];
  for (const kind of kinds) {
    const label = kind.label.toLowerCase();
    if (label.startsWith(needle)) groups[0]!.push(kind);
    else if (kind.keywords.some((word) => word.startsWith(needle))) groups[1]!.push(kind);
    else if (label.includes(needle)) groups[2]!.push(kind);
    else if (kind.keywords.some((word) => word.includes(needle))) groups[3]!.push(kind);
  }
  return groups.flat();
}
