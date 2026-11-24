import { Editor } from '@milkdown/core';
import { getMarkdown, replaceAll } from '@milkdown/utils';

/** The Markdown of the whole document as the editor holds it now. */
export const markdownOf = (editor: Editor): string => editor.action(getMarkdown());

/** Replaces the whole document with this Markdown, as one edit that collaborators see like any other. */
export const applyMarkdown = (editor: Editor, markdown: string): void => editor.action(replaceAll(markdown, true));
