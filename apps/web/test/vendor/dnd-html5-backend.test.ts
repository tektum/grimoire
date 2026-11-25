import { describe, expect, it } from 'vitest';
import * as real from 'react-dnd-html5-backend/dist/index.js';
import { HTML5Backend } from 'react-dnd-html5-backend';
import * as shim from '../../src/vendor/dnd-html5-backend';
import '../support/dom';

describe('the drag backend the page tree uses', () => {
  it('keeps everything of the package, and answers an empty image that is drawn, not loaded: no data: address, no request, one element for every call', () => {
    expect(shim.HTML5Backend).toBe(HTML5Backend);
    const image = shim.getEmptyImage() as unknown as HTMLCanvasElement;
    expect(image.tagName).toBe('CANVAS');
    expect([image.width, image.height]).toEqual([1, 1]);
    expect('src' in image).toBe(false);
    expect(shim.getEmptyImage()).toBe(shim.getEmptyImage());
  });

  it('is in the page, off the screen, and hidden from assistive technology, so that Safari does not draw its own picture instead', () => {
    const image = shim.getEmptyImage() as unknown as HTMLCanvasElement;
    expect(image.isConnected).toBe(true);
    expect(image.parentElement).toBe(document.body);
    expect(image.getAttribute('aria-hidden')).toBe('true');
    expect([image.style.position, image.style.left, image.style.top, image.style.pointerEvents]).toEqual(['fixed', '-100px', '-100px', 'none']);
    expect(image.hasAttribute('style'), 'set through the CSSOM: it is the style the engine reads back').toBe(true);
  });

  // The alias replaces a package by name: an upgrade that moves its entry file or renames what it exports must fail here, not in a page.
  it('stands in for the package as it is: the real package still has the function this replaces, and the replacement exports every name the package does', () => {
    expect(typeof real.getEmptyImage).toBe('function');
    for (const name of Object.keys(real)) expect(Object.keys(shim), `the replacement exports ${name}`).toContain(name);
    expect(real.getEmptyImage).not.toBe(shim.getEmptyImage);
  });
});
