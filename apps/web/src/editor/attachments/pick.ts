import { editorViewCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { uploadFiles } from './plugin';

/**
 * Opens the system's file chooser (images and any file, several at once) and uploads what is chosen, at the cursor, as a paste does. The promise ends when the upload has;
 * a chooser that is closed with no file ends it at once. Called from the menu, in the click or key press that chose the item (a chooser opens only from one).
 */
export function chooseFiles(ctx: Ctx): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return resolve();
      const view = ctx.get(editorViewCtx);
      void uploadFiles(files, ctx).then((fragment) => {
        if (fragment.childCount > 0) view.dispatch(view.state.tr.insert(view.state.selection.to, fragment));
        resolve();
      });
    });
    input.click();
  });
}
