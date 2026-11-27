// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The accessibility rules of docs/DESIGN.md for the palette's selected row, on the stylesheet that ships: the contrast pairs are measured on the tokens (`ui/tokens-contrast.test.ts`),
// and what forced colours keeps is read here (a browser test cannot switch forced colours on).
const css = readFileSync(new URL('../../src/palette/palette.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? '';

describe('the selected row of the palette', () => {
  it('is the row on --fill-selected, with the return glyph shown and nothing else moving', () => {
    expect(css).toMatch(/\[cmdk-item\]\[data-selected='true'\]\s*\{\s*background:\s*var\(--fill-selected\)/);
    expect(css).toMatch(/\.palette-return\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/\[data-selected='true'\] \.palette-return\s*\{\s*visibility:\s*visible/);
  });

  it('keeps a visible indicator in forced colours: the system selection pair, an outline, and the glyph, path and icon in the system text colour', () => {
    expect(forced).toMatch(/\[data-selected='true'\]\s*\{[^}]*background:\s*Highlight/);
    expect(forced).toMatch(/\[data-selected='true'\]\s*\{[^}]*color:\s*HighlightText/);
    expect(forced).toMatch(/\[data-selected='true'\]\s*\{[^}]*outline:\s*2px solid CanvasText/);
    for (const part of ['palette-path', 'palette-icon', 'palette-return', 'palette-snippet']) expect(forced).toContain(`.${part}`);
    expect(forced).toMatch(/color:\s*HighlightText/);
  });

  it('steps the path and the icon up to --ink-2 on the selected row (ink-3 on the dark selected fill is 3.7:1)', () => {
    expect(css).toMatch(/\[data-selected='true'\] \.palette-path,\s*\.palette \[cmdk-item\]\[data-selected='true'\] \.palette-icon\s*\{\s*color:\s*var\(--ink-2\)/);
  });
});
