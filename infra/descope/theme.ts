// The sign-in screens use the web client's design tokens (apps/web/src/ui/tokens.css), so the two look like one product. This file turns the CSS into the styles JSON of a Descope
// project (`globals.colors`, `globals.fonts`, `globals.radius`). Pure: no SST, no network.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type Tokens = Readonly<Record<string, string>>;
export interface TokenSets { readonly light: Tokens; readonly dark: Tokens }

const declarations = (block: string): Record<string, string> =>
  Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));

/** The light tokens (`:root`) and the dark ones (`:root[data-theme='dark']`) of the stylesheet. */
export function parseTokens(css: string): TokenSets {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^}]*)\}/.exec(stripped)?.[1];
  const dark = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(stripped)?.[1];
  if (root === undefined || dark === undefined) throw new Error("tokens.css has no :root block or no :root[data-theme='dark'] block");
  const light = declarations(root);
  return { light, dark: { ...light, ...declarations(dark) } };
}

export const readTokens = (repoRoot: string = process.cwd()): TokenSets => parseTokens(readFileSync(path.join(repoRoot, 'apps/web/src/ui/tokens.css'), 'utf8'));

const channels = (hex: string): [number, number, number] => {
  const h = /^#([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (h === undefined) throw new Error(`a colour token must be #rrggbb, not ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const toHex = (c: readonly number[]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** `hex` mixed with `with` by `amount` (0 to 1). */
export const mix = (hex: string, withHex: string, amount: number): string => {
  const a = channels(hex);
  const b = channels(withHex);
  return toHex(a.map((v, i) => v + ((b[i] ?? 0) - v) * amount));
};
export const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** The WCAG contrast ratio of two colours (1 to 21). */
export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};
/** Black or white, whichever reads better on `hex`: the two give the same contrast at a luminance of about 0.179, so the one above it takes black. */
export const contrastOn = (hex: string): string => (contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff');

const palette = (main: string) => ({ main, dark: mix(main, '#000000', 0.3), light: mix(main, '#ffffff', 0.25), highlight: mix(main, '#ffffff', 0.5), contrast: contrastOn(main) });
const family = (stack: string): string[] => stack.split(',').map((f) => f.trim().replace(/^'(.*)'$/, '$1')).filter(Boolean);
const need = (tokens: Tokens, name: string): string => {
  const value = tokens[name];
  if (value === undefined) throw new Error(`tokens.css has no ${name}`);
  return value;
};
const radius = (px: string): string => px;

function mode(tokens: Tokens) {
  return {
    globals: {
      colors: {
        primary: palette(need(tokens, '--accent')),
        secondary: palette(need(tokens, '--muted')),
        surface: { ...palette(need(tokens, '--paper-raised')), main: need(tokens, '--paper'), contrast: need(tokens, '--ink') },
      },
      fonts: {
        font1: { label: 'Serif', family: family(need(tokens, '--font-page')) },
        font2: { label: 'System', family: family(need(tokens, '--font-ui')) },
      },
      radius: { sm: radius(need(tokens, '--radius-1')), md: radius(need(tokens, '--radius-2')) },
    },
  };
}

/** The `data` of a Descope styles resource: the export shape `{ componentsVersion, references, styles: { light, dark } }`. */
export function buildStyles(tokens: TokenSets): { componentsVersion: string; references: Record<string, never>; styles: { light: ReturnType<typeof mode>; dark: ReturnType<typeof mode> } } {
  return { componentsVersion: '3.27.2', references: {}, styles: { light: mode(tokens.light), dark: mode(tokens.dark) } };
}
