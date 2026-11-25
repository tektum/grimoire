// react-arborist (the page tree) asks `react-dnd-html5-backend` for an empty image to hide the browser's own drag picture, and the backend answers an `Image` whose `src` is a `data:` GIF. The
// page's `img-src` has no `data:` (rule 4 of the content security policy depends on it), so every page with a tree row reported a violation. This module is that package with the one function
// changed: the empty image is a 1 by 1 canvas, which is a drawn element and loads nothing. The build and the tests alias `react-dnd-html5-backend` to this file (`vite.config.ts`).
export * from 'react-dnd-html5-backend/dist/index.js';

let emptyImage: HTMLCanvasElement | undefined;

/** A transparent 1 by 1 element for `setDragImage`. Typed as the package types it (an image): the backend only hands it to the browser as the drag image. */
export function getEmptyImage(): HTMLImageElement {
  if (emptyImage === undefined) {
    emptyImage = document.createElement('canvas');
    emptyImage.width = 1;
    emptyImage.height = 1;
  }
  return emptyImage as unknown as HTMLImageElement;
}
