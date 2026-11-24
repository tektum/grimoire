import { editorViewCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { trailing, trailingConfig } from '@milkdown/plugin-trailing';

/**
 * The empty paragraph after a last block that is not text (a table, a code block, a divider, a list), so the cursor always has somewhere to go below it. It is added only
 * where the editor can be edited: a person who can only read must not write into the shared document. (The saved Markdown drops empty paragraphs at the end of the
 * page, so it is the same with or without this one.)
 */
const onlyWhereEditable: MilkdownPlugin = (ctx) => () => {
  ctx.update(trailingConfig.key, (config) => ({
    ...config,
    shouldAppend: (lastNode, state) => config.shouldAppend(lastNode, state) && ctx.get(editorViewCtx).editable === true,
  }));
};

export const trailingNode: MilkdownPlugin[] = [trailingConfig, onlyWhereEditable, ...trailing.slice(1)];
