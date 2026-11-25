import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Snippet, usableRanges } from '../../src/search/Snippet';
import '../support/dom';

afterEach(cleanup);
const draw = (text: string, ranges: readonly (readonly [number, number])[]) => render(createElement('p', null, createElement(Snippet, { snippet: { text, ranges } })));

describe('the snippet of a search result', () => {
  it('draws the literal text of a script and one mark around the match, and nothing runs', () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    const { container } = draw('a <script>alert(1)</script> x', [[28, 29]]);
    expect(container.textContent).toBe('a <script>alert(1)</script> x');
    expect(container.querySelector('script')).toBeNull();
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('x');
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('draws markup in the match itself as text too (an image with an error handler is not made)', () => {
    const { container } = draw('<img src=x onerror=alert(1)>', [[0, 28]]);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('mark')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('marks several matches, in order, and keeps the text between them', () => {
    const { container } = draw('one two three', [
      [8, 13],
      [0, 3],
    ]);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['one', 'three']);
    expect(container.textContent).toBe('one two three');
  });

  it('ignores ranges outside the text, empty, backwards, fractional and overlapping (the earlier one stays)', () => {
    expect(
      usableRanges('abcdef', [
        [4, 9],
        [-1, 2],
        [3, 3],
        [5, 2],
        [0.5, 2],
        [1, 3],
        [2, 4],
        [3, 5],
      ]),
    ).toEqual([
      [1, 3],
      [3, 5],
    ]);
  });

  it('draws plain text when there is nothing to mark', () => {
    const { container } = draw('nothing here', []);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('nothing here');
  });
});
