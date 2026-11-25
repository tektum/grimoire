/** The contrast ratio of two colours as the engine writes them (`rgb(...)` or `rgba(...)`, WCAG 2). */
export function contrastRatio(a: string, b: string): number {
  const channels = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).map(Number);
  const luminance = ([r = 0, g = 0, bl = 0]: number[]): number => {
    const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [hi, lo] = [luminance(channels(a)), luminance(channels(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
