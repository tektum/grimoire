import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorView } from '@milkdown/prose/view';
import { LockNotice } from './LockNotice';

const notices = new WeakMap<EditorView, { host: HTMLElement; root: Root; stop: (() => void) | null }>();

/** Ends what waits on the message (a name that is still to come): it is for the message that is showing, and goes with it. */
function endWaiting(view: EditorView): void {
  const notice = notices.get(view);
  const stop = notice?.stop ?? null;
  if (notice !== undefined) notice.stop = null;
  if (stop !== null) stop();
}

/** Hands over what is to be ended when this message is replaced, taken away or goes with the editor. */
export function whileLockNoticeShown(view: EditorView, stop: () => void): void {
  const notice = notices.get(view);
  if (notice === undefined) stop();
  else notice.stop = stop;
}

/** Shows the lock message under the block at `pos`, in place of any earlier one; the focus stays in the text. */
export function showLockNotice(view: EditorView, pos: number, message: string): void {
  endWaiting(view);
  let notice = notices.get(view);
  if (notice === undefined) {
    const host = document.createElement('div');
    host.className = 'lock-notice-host';
    (view.dom.parentElement ?? document.body).append(host);
    notice = { host, root: createRoot(host), stop: null };
    notices.set(view, notice);
  }
  const { host, root } = notice;
  host.dataset['show'] = 'true'; // shown first: a hidden element has no offset parent to measure from
  const place = (): void => {
    const at = view.coordsAtPos(pos);
    const parent = (host.offsetParent ?? host.parentElement ?? document.body).getBoundingClientRect();
    host.style.top = `${Math.round(at.bottom - parent.top + 6)}px`;
    host.style.left = `${Math.round(Math.max(0, at.left - parent.left))}px`;
  };
  try {
    place();
  } catch {
    // the position cannot be drawn (the view is going): the message goes where the host is
  }
  flushSync(() => root.render(createElement(LockNotice, { message, onDismiss: () => hideLockNotice(view) })));
}

/** Whether the lock message is showing. */
export const lockNoticeShown = (view: EditorView): boolean => notices.get(view)?.host.dataset['show'] === 'true';

/** Takes the lock message away. */
export function hideLockNotice(view: EditorView): void {
  endWaiting(view);
  const notice = notices.get(view);
  if (notice === undefined) return;
  notice.host.dataset['show'] = 'false';
  notice.root.render(null);
  view.focus();
}

/** Takes the message and its element down with the editor. */
export function disposeLockNotice(view: EditorView): void {
  endWaiting(view);
  const notice = notices.get(view);
  if (notice === undefined) return;
  notice.root.unmount();
  notice.host.remove();
  notices.delete(view);
}
