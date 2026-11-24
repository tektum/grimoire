import type { Ctx } from '@milkdown/ctx';
import { editorViewCtx } from '@milkdown/core';
import { UNKNOWN_NAME } from '../core/directory';
import { blockIdAt } from './block-id';
import { lockContext } from './context';
import { holderOf } from './holder';
import { hideLockNotice, showLockNotice, whileLockNoticeShown } from './notice';
import { lockMessage } from './texts';

/** What the guard needs to know of a block kind: whether running it recreates the block (a list, a quote, a code block) or only changes an attribute. */
export interface Guarded {
  readonly structural?: boolean;
}

/**
 * The soft lock (R3.14): a conversion that recreates a block is refused while another person's cursor is in it, and the message says who. Changing a heading level, or
 * adding a divider or a table, is not refused: concurrent typing survives those. Returns whether the conversion may go on; when it may not, the message is shown under the block.
 */
export function allowBlockChange(ctx: Ctx, kind: Guarded, pos: number): boolean {
  const view = ctx.get(editorViewCtx);
  if (kind.structural !== true) {
    hideLockNotice(view);
    return true;
  }
  const context = ctx.get(lockContext.key);
  const blockId = context === null ? null : blockIdAt(view.state, pos);
  const holder = context === null || blockId === null ? null : holderOf(context, blockId);
  if (context === null || holder === null) {
    hideLockNotice(view);
    return true;
  }
  context.directory.request([holder]);
  const name = context.directory.nameOf(holder);
  showLockNotice(view, pos, lockMessage(name));
  if (name === UNKNOWN_NAME) {
    // The name is not known yet: the message says it as soon as the directory has it.
    // It is for this message only: a newer message, Close, or the editor going ends the wait (notice.ts), so no listener outlives the message it was made for.
    const stop = context.directory.subscribe(() => {
      const known = context.directory.nameOf(holder);
      if (known === UNKNOWN_NAME) return;
      showLockNotice(view, pos, lockMessage(known)); // this ends the wait, and so the subscription
    });
    whileLockNoticeShown(view, stop);
  }
  return false;
}
