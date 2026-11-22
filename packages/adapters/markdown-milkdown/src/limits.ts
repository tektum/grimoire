/** Limits of one conversion. The worker pool passes them in; these are the defaults. */
export interface ConverterLimits {
  /** Largest Yjs update accepted, in bytes. */
  maxStateBytes: number;
  /** Deepest nesting of elements under the fragment. */
  maxDepth: number;
  /** Most elements (blocks and inline nodes) in the fragment. */
  maxBlocks: number;
  /** Largest Markdown accepted for seeding, in UTF-8 bytes. */
  maxSeedMarkdownBytes: number;
  /**
   * Parse the Markdown just written and compare the document with the one it came from; a difference is
   * `content-lost`. The cost is one Markdown parse (see docs/proof/m2-conversion.md). Default on.
   */
  verifyRoundTrip: boolean;
}

export const DEFAULT_LIMITS: ConverterLimits = Object.freeze({
  maxStateBytes: 1_536_000,
  maxDepth: 100,
  maxBlocks: 50_000,
  maxSeedMarkdownBytes: 1_048_576,
  verifyRoundTrip: true,
});

const NUMERIC: readonly (keyof ConverterLimits)[] = ['maxStateBytes', 'maxDepth', 'maxBlocks', 'maxSeedMarkdownBytes'];

/** The defaults, with the caller's overrides: an absent (undefined) override keeps the default; every given limit must be a positive integer, so a NaN or a 0 cannot switch a check off. */
export function resolveLimits(limits: Partial<ConverterLimits> | undefined): ConverterLimits {
  const resolved: ConverterLimits = { ...DEFAULT_LIMITS };
  for (const key of NUMERIC) {
    const value = limits?.[key] as number | undefined;
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${key} must be a positive integer`);
    (resolved as unknown as Record<string, number>)[key] = value;
  }
  if (limits?.verifyRoundTrip !== undefined) resolved.verifyRoundTrip = limits.verifyRoundTrip;
  return resolved;
}
