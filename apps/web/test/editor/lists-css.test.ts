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
    for (const line of colours) expect(line).toMatch(/var\(--[a-z-]+\)|transparent|none|solid/);
  });

  it('draws the markers it needs: bullets in three shapes, the number as written, a task box and a tick', () => {
    expect(css).toContain('attr(data-label)');
    expect(css).toContain("'\\25E6'");
    expect(css).toContain("'\\25AA'");
    expect(css).toContain("li[data-item-type='task']::before");
    expect(css).toContain("[data-checked='true']::after");
  });

  it('gives the number of an ordered item a column that grows with it, so a long number never runs into the text', () => {
    expect(css).toMatch(/ol > li \{[^}]*display: grid[^}]*max-content/);
    expect(css).toMatch(/ol > li::before \{[^}]*position: static/);
  });
});
