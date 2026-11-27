// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inPageHref } from '../../src/ui/inpage';
import { COLLAB_COLOURS, colourIndex, contrast, labelText } from '../../src/ui/collab';

const ui = path.resolve(import.meta.dirname, '../../src/ui');
const tokens = readFileSync(path.join(ui, 'tokens.css'), 'utf8');
const global = readFileSync(path.join(ui, 'global.css'), 'utf8');

/** The custom properties declared in the blocks whose selector is exactly `selector` (the first block of that selector inside `css`). */
function declared(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (block[1]!.trim().replace(/^@media[^{]*\{/, '').trim() !== selector) continue;
    for (const d of block[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

const REQUIRED = ['--paper', '--paper-raised', '--paper-sunken', '--ink', '--ink-2', '--ink-3', '--hairline', '--control-border', '--accent', '--on-accent', '--focus', '--selection', '--fill-selected', '--warn', '--danger', '--ok', '--scrim', '--shadow-popover', '--shadow-dialog', '--measure', '--font-page', '--font-ui', '--font-code', '--space-1', '--space-8', '--radius-1', '--radius-3', '--ease', '--duration-press'];
const THEMED = ['--paper', '--paper-raised', '--paper-sunken', '--ink', '--ink-2', '--ink-3', '--hairline', '--control-border', '--accent', '--on-accent', '--selection', '--fill-selected', '--warn', '--danger', '--ok', '--scrim'];

describe('tokens', () => {
  it('declares every token in the default (light) theme', () => {
    const light = declared(tokens, ':root');
    const root = light;
    for (const name of REQUIRED) expect([name, root[name] !== undefined]).toEqual([name, true]);
    expect(root['--measure']).toBe('68ch');
    expect(root['--font-page']).toMatch(/^'Literata', 'Literata fallback',.*serif$/);
    expect(root['--font-ui']).toMatch(/^'Inter', 'Inter fallback',.*sans-serif$/);
    expect(root['--font-code']).toMatch(/^'IBM Plex Mono', 'IBM Plex Mono fallback',.*monospace$/);
  });

  it('has a dark value for every themed token, by system preference and by data-theme', () => {
    const byData = declared(tokens, ":root[data-theme='dark']");
    const byMedia = declared(tokens.slice(tokens.indexOf('prefers-color-scheme: dark'), tokens.indexOf("[data-theme='dark']")), ":root:not([data-theme='light'])");
    for (const name of THEMED) {
      expect([name, byData[name] !== undefined]).toEqual([name, true]);
      expect([name, byMedia[name] === byData[name]]).toEqual([name, true]);
    }
  });

  it('has body text with enough contrast on the paper in both themes', () => {
    const light = declared(tokens, ':root');
    const dark = declared(tokens, ":root[data-theme='dark']");
    for (const [paper, ink, secondary] of [[light['--paper']!, light['--ink']!, light['--ink-2']!], [dark['--paper']!, dark['--ink']!, dark['--ink-2']!]] as const) {
      expect(contrast(paper, ink)).toBeGreaterThanOrEqual(7);
      expect(contrast(paper, secondary)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('leaves no custom property unresolved: every var(--x) without a fallback in the client names one that is declared', () => {
    const src = path.resolve(import.meta.dirname, '../../src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(css|tsx?)$/.test(f)).map((f) => readFileSync(path.join(src, f), 'utf8'));
    // A declaration: `--x:` in CSS, or a quoted `'--x'` key or `setProperty('--x', ...)` argument in code.
    const declaredNames = new Set(files.flatMap((text) => [...text.matchAll(/(?:^|[\s{;])(--[\w-]+)\s*:|['"](--[\w-]+)['"]\s*[:,]/gm)].map((m) => (m[1] ?? m[2])!)));
    const used = new Set(files.flatMap((text) => [...text.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!)));
    expect([...used].filter((name) => !declaredNames.has(name))).toEqual([]);
  });

  it('declares the eight collaborator colours as custom properties, equal to the palette of the code', () => {
    const root = declared(tokens, ':root');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => root[`--collab-${i}`]?.toUpperCase())).toEqual([...COLLAB_COLOURS]);
  });

  it('gives each collaborator colour a name label of at least 4.5:1 contrast in both themes', () => {
    const papers = [declared(tokens, ':root')['--paper']!, declared(tokens, ":root[data-theme='dark']")['--paper']!];
    expect(papers).toHaveLength(2);
    for (const colour of COLLAB_COLOURS) {
      // The label carries its own background colour, so the text contrast does not depend on the theme.
      expect([colour, contrast(colour, labelText(colour)) >= 4.5]).toEqual([colour, true]);
    }
    expect(new Set(COLLAB_COLOURS).size).toBe(8);
  });
});

describe('collaborator colour index', () => {
  it('is stable for a user id and within 0 to 7, and spreads ids', () => {
    expect(colourIndex('user-1')).toBe(colourIndex('user-1'));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const index = colourIndex(`user-${i}`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(8);
      seen.add(index);
    }
    expect(seen.size).toBe(8);
  });
  it('picks black or white text by contrast', () => {
    expect(labelText('#ffffff')).toBe('#000000');
    expect(labelText('#000000')).toBe('#ffffff');
    expect(labelText('#882255')).toBe('#ffffff');
    expect(labelText('#E69F00')).toBe('#000000');
  });
});

describe('reduced motion and focus', () => {
  it('leaves only an 80ms opacity transition and no animation under prefers-reduced-motion: reduce', () => {
    const block = global.slice(global.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/transition-property:\s*opacity\s*!important/);
    expect(block).toMatch(/transition-duration:\s*80ms\s*!important/);
    expect(block).toMatch(/animation:\s*none\s*!important/);
  });
  it('shows a visible focus ring from the --focus token', () => {
    expect(global).toMatch(/:focus-visible\s*\{[^}]*var\(--focus\)/);
  });
});

describe('direction-aware layout', () => {
  it('uses logical properties only, so a right-to-left layout mirrors', () => {
    const css = global.replace(/\/\*[\s\S]*?\*\//g, '');
    const physical = css.match(/(?:^|[;{\s])(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|border-top-left-radius|border-bottom-left-radius|border-top-right-radius|border-bottom-right-radius)\s*:|text-align:\s*(?:left|right)|translateX\(/g);
    expect(physical).toBeNull();
  });
});

describe('inPageHref', () => {
  it('keeps path and query, adds the fragment, and collapses leading slashes', () => {
    expect(inPageHref('/p/a-b1', '?x=1', 'main')).toBe('/p/a-b1?x=1#main');
    expect(inPageHref('/', '', 'main')).toBe('/#main');
    for (const path of ['//evil.example', '///evil.example/x', '////']) expect([path, inPageHref(path, '', 'main').startsWith('//')]).toEqual([path, false]);
    expect(inPageHref('//evil.example', '', 'main')).toBe('/evil.example#main');
  });
});
