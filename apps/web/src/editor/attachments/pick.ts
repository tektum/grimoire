import { editorViewCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { addAnchor, anchorPosition, dropAnchor } from './anchor';
import { uploadFiles } from './plugin';

/**
 * Opens the system's file chooser (images and any file, several at once) and uploads what is chosen, at the place where the item was chosen, as a paste does there. The
 * promise ends when the upload has, or at once when the chooser is closed with no file (the browser says `cancel` then, not `change`) or the editor is gone by the time
 * the upload has finished. Called from the menu, in the click or key press that chose the item (a chooser opens only from one).
 */
export function chooseFiles(ctx: Ctx): Promise<void> {
  return new Promise((resolve) => {
    const view = ctx.get(editorViewCtx);
    const anchor = addAnchor(view, view.state.selection.to);
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    const finish = (): void => {
      if (!(view as { isDestroyed?: boolean }).isDestroyed) dropAnchor(view, anchor);
      resolve();
    };
    input.addEventListener('cancel', finish);
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return finish();
      void uploadFiles(files, ctx).then((fragment) => {
        if ((view as { isDestroyed?: boolean }).isDestroyed) return resolve();
        const pos = anchorPosition(view, anchor);
        if (fragment.childCount > 0 && pos !== undefined) view.dispatch(view.state.tr.insert(pos, fragment));
        finish();
      });
    });
    input.click();
  });
}
