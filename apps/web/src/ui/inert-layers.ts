/**
 * The dialog library (Radix, under every menu, dialog and confirmation of the app) hides the rest of the app from a screen reader while a layer is open, by `aria-hidden` on it and a marker attribute
 * (`data-aria-hidden`). That leaves what is in the hidden part focusable and clickable by script, and an `aria-hidden` region that holds focusable elements is an accessibility violation (axe:
 * aria-hidden-focus). This makes whatever the library marks `inert` too (neither focusable nor read) for as long as it is marked, in one place for every layer there is or will be.
 * An element that was `inert` before the library marked it stays so afterwards.
 */
const MARKER = 'data-aria-hidden';
const MADE_INERT = 'data-made-inert';

function sync(element: Element): void {
  const marked = element.getAttribute(MARKER) === 'true';
  if (marked && !element.hasAttribute('inert')) {
    element.setAttribute('inert', '');
    element.setAttribute(MADE_INERT, '');
  } else if (!marked && element.hasAttribute(MADE_INERT)) {
    element.removeAttribute('inert');
    element.removeAttribute(MADE_INERT);
  }
}

/** Starts following the marker on the document; returns what stops it (and lets go of what it made inert). */
export function followDialogLayers(root: Document = document): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') sync(record.target as Element);
      else for (const node of record.addedNodes) if (node instanceof Element) sync(node);
    }
  });
  observer.observe(root.body, { attributes: true, attributeFilter: [MARKER], subtree: true, childList: true });
  for (const element of root.querySelectorAll(`[${MARKER}]`)) sync(element);
  return () => {
    observer.disconnect();
    for (const element of root.querySelectorAll(`[${MADE_INERT}]`)) {
      element.removeAttribute('inert');
      element.removeAttribute(MADE_INERT);
    }
  };
}
