import { type RefCallback } from 'react';

/** How many frames the focus is waited for: the rest of the app is let go of by the next microtask after a layer closes, so the wait is short; the bound is for an element that stays inert. */
const MAX_FRAMES = 30;

/**
 * A ref that gives the element the focus as soon as it can take it, for a field that opens with a menu item or a button (instead of `autoFocus`, which acts at mount, while the rest of the app is
 * still `inert` for a moment after a menu or a dialog closes: see `ui/inert-layers.ts`, and an inert element cannot take the focus). It tries at mount, and then each frame while the element is inside
 * something inert, and stops when the element has the focus, when it is gone, or after a short while.
 */
export const focusWhenReady: RefCallback<HTMLElement> = (element) => {
  if (element === null) return undefined;
  let frame = 0;
  let cancelled = false;
  let tries = 0;
  const attempt = (): void => {
    if (cancelled || !element.isConnected) return;
    if (element.closest('[inert]') === null) {
      element.focus();
      if (document.activeElement === element) return;
    }
    if (++tries < MAX_FRAMES) frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
};
