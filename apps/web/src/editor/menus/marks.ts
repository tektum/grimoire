import { commandsCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand } from '@milkdown/preset-commonmark';
import { toggleStrikethroughCommand } from '@milkdown/preset-gfm';
import { isSafeUrl } from '@tektum/grimoire-editor-schema';
import { TextSelection, type EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/** The text the link editor shows when an address is refused. */
export const LINK_REFUSAL = 'Only web, mail and relative links are allowed';

export type InlineKind = 'bold' | 'italic' | 'strike' | 'code';
export const INLINE_KINDS: readonly { readonly id: InlineKind; readonly label: string; readonly mark: string }[] = [
  { id: 'bold', label: 'Bold', mark: 'strong' },
  { id: 'italic', label: 'Italic', mark: 'emphasis' },
  { id: 'strike', label: 'Strikethrough', mark: 'strike_through' },
  { id: 'code', label: 'Code', mark: 'inlineCode' },
];

/** Which inline marks the whole selection carries (a mark that only part of it has is not "on"). */
export function activeInline(state: EditorState): Record<InlineKind, boolean> {
  const { from, to } = state.selection;
  const has = (name: string): boolean => {
    const type = state.schema.marks[name];
    if (type === undefined || from === to) return false;
    let all = true;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isText && !type.isInSet(node.marks)) all = false;
    });
    return all;
  };
  return { bold: has('strong'), italic: has('emphasis'), strike: has('strike_through'), code: has('inlineCode') };
}

/** The address of the link the selection starts in, or null. */
export function linkAt(state: EditorState): string | null {
  const type = state.schema.marks['link'];
  const { from, to } = state.selection;
  if (type === undefined) return null;
  let href: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = node.isText ? type.isInSet(node.marks) : undefined;
    if (href === null && mark !== undefined && mark !== null && typeof mark.attrs['href'] === 'string') href = mark.attrs['href'];
  });
  return href;
}

/** Toggles an inline mark on the selection, through the editor's own command. */
export function toggleInline(ctx: Ctx, kind: InlineKind): boolean {
  const commands = ctx.get(commandsCtx);
  switch (kind) {
    case 'bold':
      return commands.call(toggleStrongCommand.key);
    case 'italic':
      return commands.call(toggleEmphasisCommand.key);
    case 'strike':
      return commands.call(toggleStrikethroughCommand.key);
    case 'code':
      return commands.call(toggleInlineCodeCommand.key);
  }
}

/**
 * Puts a link on the selection, or takes the link off it when `address` is empty. An address that the schema does not allow (`isSafeUrl`) is refused and the document is not
 * touched. Returns what happened.
 */
export function setLink(view: EditorView, address: string): 'linked' | 'unlinked' | 'refused' {
  const type = view.state.schema.marks['link'];
  const { from, to } = view.state.selection;
  if (type === undefined || from === to) return 'refused';
  const href = address.trim();
  if (href === '') {
    view.dispatch(view.state.tr.removeMark(from, to, type));
    return 'unlinked';
  }
  if (!isSafeUrl(href, 'link')) return 'refused';
  view.dispatch(view.state.tr.removeMark(from, to, type).addMark(from, to, type.create({ href })));
  return 'linked';
}

/** Whether the bubble is for this selection: a range of text, in an editor that can be edited, not in a code block. */
export function bubbleSelection(view: EditorView): boolean {
  const { selection } = view.state;
  if (!view.editable || !(selection instanceof TextSelection) || selection.empty) return false;
  return !selection.$from.parent.type.spec.code && !selection.$to.parent.type.spec.code;
}
