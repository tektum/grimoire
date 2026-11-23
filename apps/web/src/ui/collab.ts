/** The eight collaborator colours (contracts section 9), the same values as `--collab-0..7` in tokens.css. */
export const COLLAB_COLOURS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#E69F00', '#882255', '#44AA99'] as const;

/** Colour index of a user: a stable hash of the id, modulo 8 (FNV-1a, so it is the same on every client). */
export function colourIndex(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % COLLAB_COLOURS.length;
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** The name label's text: black or white, whichever reads better on the colour. */
export function labelText(background: string): '#000000' | '#ffffff' {
  return contrast(background, '#000000') >= contrast(background, '#ffffff') ? '#000000' : '#ffffff';
}
