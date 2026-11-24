import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../support/dom';
import { renderPage, width } from './support';

beforeEach(() => { width(1400); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the levels of the outline', () => {
  it('lists headings of levels 1 to 6 in order, and indents levels 4, 5 and 6 as level 4 (at most three steps)', () => {
    renderPage([[1, 'H1'], [2, 'H2'], [3, 'H3'], [4, 'H4'], [5, 'H5'], [6, 'H6']]);
    const links = within(screen.getByRole('navigation', { name: 'Page outline' })).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    expect(links.map((a) => Number(a.getAttribute('data-indent')))).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('does not list a paragraph with level 0 (it is drawn as a paragraph)', () => {
    renderPage([[1, 'Real'], [0, 'Just text'], [2, 'Sub']]);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Real', 'Sub']);
  });
});
