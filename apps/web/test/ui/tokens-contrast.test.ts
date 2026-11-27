// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from '../../src/ui/collab';

// The contrast tables of the system in docs/DESIGN.md, measured on the values tokens.css declares, so a token edit that breaks AA fails here.
const css = readFileSync(new URL('../../src/ui/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties of every block whose selector is exactly `selector`, later blocks winning. */
function declared(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (block[1]!.trim() !== selector) continue;
    for (const d of block[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

const light = declared(':root');
const themes = { light, dark: { ...light, ...declared(":root[data-theme='dark']") } };
type Theme = Record<string, string>;

/** A token's value with `var(--x)` references followed, as `[r, g, b, alpha]`. */
function colour(theme: Theme, name: string): [number, number, number, number] {
  let value = theme[name];
  for (let hops = 0; value?.startsWith('var(') && hops < 8; hops++) value = theme[/var\((--[\w-]+)\)/.exec(value)![1]!];
  if (value === undefined) throw new Error(`${name} is not declared`);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`${name} is not a colour this test reads: ${value}`);
}

/** A surface as a `#rrggbb` colour: one token, or `--a over --b` for a translucent fill on a surface. */
function surface(theme: Theme, spec: string): string {
  const [top, under] = spec.split(' over ') as [string, string | undefined];
  const [r, g, b, a] = colour(theme, top);
  const base = under === undefined ? [r, g, b] : colour(theme, under);
  if (under === undefined && a !== 1) throw new Error(`${top} is translucent: name the surface under it`);
  const mixed = [r, g, b].map((c, i) => Math.round(c * a + base[i]! * (1 - a)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const TEXT = 4.5;
const EDGE = 3;
// [what, foreground, background, needs]: the rows of the contrast table under "The system".
const PAIRS: readonly (readonly [string, string, string, number])[] = [
  ['body text', '--ink', '--paper', TEXT],
  ['body text on contents', '--ink', '--paper-sunken', TEXT],
  ['secondary text', '--ink-2', '--paper', TEXT],
  ['secondary text on contents', '--ink-2', '--paper-sunken', TEXT],
  ['metadata', '--ink-3', '--paper', TEXT],
  ['metadata on menus', '--ink-3', '--paper-raised', TEXT],
  ['metadata on contents', '--ink-3', '--paper-sunken', TEXT],
  ['link', '--accent', '--paper', TEXT],
  ['text on accent', '--on-accent', '--accent', TEXT],
  ['warning text', '--warn', '--paper', TEXT],
  ['danger text', '--danger', '--paper', TEXT],
  ['control border on paper', '--control-border', '--paper', EDGE],
  ['control border on contents', '--control-border', '--paper-sunken', EDGE],
  ['control border on menus', '--control-border', '--paper-raised', EDGE],
  ['focus ring on paper', '--focus', '--paper', EDGE],
  ['focus ring on contents', '--focus', '--paper-sunken', EDGE],
  ['focus ring on menus', '--focus', '--paper-raised', EDGE],
  ['text on selection', '--ink', '--selection', TEXT],
  ['text on a selected menu row', '--ink', '--fill-selected over --paper-raised', TEXT],
  ['path and hint on a selected menu row', '--ink-2', '--fill-selected over --paper-raised', TEXT],
];

describe('the contrast of the tokens (docs/DESIGN.md)', () => {
  for (const [name, theme] of Object.entries(themes)) {
    it.each(PAIRS)(`${name}: %s`, (_what, fg, bg, needs) => {
      expect(contrast(surface(theme, fg), surface(theme, bg))).toBeGreaterThanOrEqual(needs);
    });

    it(`${name}: every collaborator's caret reaches 3:1 on the paper`, () => {
      for (let i = 0; i < 8; i++) {
        const caret = `--collab-caret-${i}`;
        expect([caret, contrast(surface(theme, caret), surface(theme, '--paper')) >= EDGE]).toEqual([caret, true]);
      }
    });
  }

  it('gives the dark theme the same values by system preference as by data-theme', () => {
    const byData = declared(":root[data-theme='dark']");
    const media = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^{}]*)\}/.exec(css);
    expect(media, 'a dark block by system preference').not.toBeNull();
    const byMedia = Object.fromEntries([...media![1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()]));
    expect(byMedia).toEqual(byData);
  });
});
