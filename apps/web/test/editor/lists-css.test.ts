// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/editor/core/lists.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the list styles use the design tokens only', () => {
  it('has no colour of its own: no hex, rgb, hsl or named colour values', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^{]*\{)/); // a hex colour outside a selector
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
    expect(css).not.toMatch(/:\s*(red|blue|green|black|white|gray|grey|orange|yellow|purple)\b/);
  });

  it('takes every colour from a token', () => {
    const colours = [...css.matchAll(/(?:color|background|border-color|border):[^;]*;/g)].map((m) => m[0]);
    expect(colours.length).toBeGreaterThan(0);
    for (const line of colours) expect(line).toMatch(/var\(--[a-z0-9-]+\)|transparent|none|solid/);
  });

  it('draws the markers it needs: bullets in three shapes, the number from position, a task box and a tick', () => {
    expect(css).toContain('attr(data-label)'); // bullets only: an ordered item's own rule below overrides it
    expect(css).toContain('counter-increment: list-item');
    expect(css).toContain("content: counter(list-item) '.'");
    expect(css).toContain("'\\25E6'");
    expect(css).toContain("'\\25AA'");
    expect(css).toContain("li[data-item-type='task']::before");
    expect(css).toContain("[data-checked='true']::after");
  });

  it('numbers ordered items by position from the start of the list (the browser counter of lists), never from the stored label, in a column that grows with the number', () => {
    expect(css).toMatch(/ol > li \{[^}]*display: grid[^}]*max-content/);
    expect(css).toMatch(/ol > li::before \{[^}]*position: static/);
    expect(css.match(/ol > li::before \{[^}]*\}/)![0]).not.toContain('data-label'); // the stored label is not used for numbers
  });

  it('applies to the editor only: every selector starts at the editor root, so the plain lists of other pages in the reading column keep their markers', () => {
    const selectors = [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim()));
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) expect(selector.startsWith('.page-editor.page-text')).toBe(true);
  });
});
