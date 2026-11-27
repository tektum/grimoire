// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/editor/menus/menus.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the styles of the editor menus', () => {
  it('use the design tokens only: no colour of their own', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
    expect(css).not.toMatch(/:\s*(red|blue|green|black|white|gray|grey|orange|yellow|purple)\b/);
    const colours = [...css.matchAll(/(?:color|background|border-color|border|outline):[^;]*;/g)].map((m) => m[0]);
    expect(colours.length).toBeGreaterThan(0);
    // System colours are what forced colours mode asks for (DESIGN.md "Accessibility rules"): they are not colours of the menus' own.
    for (const line of colours) expect(line).toMatch(/var\(--[a-z0-9-]+\)|color-mix\(|transparent|none|solid|\b(Highlight|HighlightText)\b/);
  });

  it('keep the slash menu out of sight until the library shows it: the host has no `data-show` before that', () => {
    expect(css).toMatch(/\.slash-host:not\(\[data-show='true'\]\)\s*\{\s*display:\s*none/);
  });

  it('hide the bubble the same way, and the block handle by its visibility (the library measures it before it marks it shown)', () => {
    expect(css).toMatch(/\.bubble-host:not\(\[data-show='true'\]\)\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.block-handle:not\(\[data-show='true'\]\)\s*\{\s*visibility:\s*hidden/);
    expect(css).not.toMatch(/\.block-handle:not\(\[data-show='true'\]\)\s*\{[^}]*display:\s*none/);
  });
});
