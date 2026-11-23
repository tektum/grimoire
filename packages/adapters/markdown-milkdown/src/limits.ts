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
  /** Most lines in Markdown accepted for seeding (each of LF, CRLF and a lone CR ends one). */
  maxSeedLines: number;
  /** Most quote and list markers in the prefix of one line of Markdown accepted for seeding. */
  maxSeedLineMarkers: number;
  /** Largest Markdown, in UTF-8 bytes, that the system rebuilds a page from (Markdown our own serialiser stored): the stored-Markdown cap. */
  maxReseedMarkdownBytes: number;
  /** Most quote and list markers in the prefix of one line of Markdown that the system rebuilds a page from. Stack safety, not cost: the serialiser writes at most `maxDepth` of them. */
  maxReseedLineMarkers: number;
  /**
   * Parse the Markdown just written and compare the document with the one it came from; a difference is
   * `content-lost`. The cost is one Markdown parse (see docs/proof/m2-conversion.md). Default on.
   */
  verifyRoundTrip: boolean;
}

export const DEFAULT_LIMITS: ConverterLimits = Object.freeze({
  maxStateBytes: 1_000_000,
  maxDepth: 100,
  maxBlocks: 50_000,
  maxSeedMarkdownBytes: 131_072,
  maxSeedLines: 8_000,
  maxSeedLineMarkers: 50,
  maxReseedMarkdownBytes: 1_048_576,
  maxReseedLineMarkers: 100,
  verifyRoundTrip: true,
});

const NUMERIC: readonly (keyof ConverterLimits)[] = ['maxStateBytes', 'maxDepth', 'maxBlocks', 'maxSeedMarkdownBytes', 'maxSeedLines', 'maxSeedLineMarkers', 'maxReseedMarkdownBytes', 'maxReseedLineMarkers'];

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
