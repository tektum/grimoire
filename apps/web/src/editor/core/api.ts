import { Editor } from '@milkdown/core';
import { getMarkdown, replaceAll } from '@milkdown/utils';

/** The Markdown of the whole document as the editor holds it now. */
export const markdownOf = (editor: Editor): string => editor.action(getMarkdown());

/**
 * Replaces the whole document with this Markdown, as one edit that collaborators see like any other. It is a transaction on the
 * editor's state: building a new state instead (the `flush` form) would drop the binding to the shared document, so the text would never reach it.
 */
export const applyMarkdown = (editor: Editor, markdown: string): void => editor.action(replaceAll(markdown));
