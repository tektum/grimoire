import { describe, expect, it } from 'vitest';
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
});
