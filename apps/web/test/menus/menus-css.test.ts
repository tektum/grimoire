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
    for (const line of colours) expect(line).toMatch(/var\(--[a-z-]+\)|color-mix\(|transparent|none|solid/);
  });

  it('keep the slash menu out of sight until the library shows it: the host has no `data-show` before that, and never has one in an editor that cannot be edited', () => {
    expect(css).toMatch(/\.slash-host:not\(\[data-show='true'\]\)\s*\{\s*display:\s*none/);
    expect(css).not.toMatch(/\.slash-host\[data-show='false'\]/); // that selector leaves the host showing until the first update
  });
});
