import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';

/**
 * Compile-time check (it is built with the package, so the build fails if it stops holding): the user-facing seed takes the Markdown
 * and a key, nothing else, so a caller cannot hand it limits; the lenient rebuild is a different method that takes a page key.
 */
export function userSeedTakesNoLimits(converter: MarkdownConverter): void {
  void converter.seed('x', 'user');
  // @ts-expect-error a third argument (limits) is not accepted by the port's user seed
  void converter.seed('x', 'user', { maxSeedLines: 1_000_000 });
  // @ts-expect-error the seed key is required
  void converter.seed('x');
}
