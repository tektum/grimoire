import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { ConvertResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { checkNoLoss, compareDocuments, guardState, sanitise, seedMarkdownProblem, tooManyChildren } from './guards.js';
import { getHeadless } from './headless.js';
import type { Headless } from './headless.js';
import { resolveLimits } from './limits.js';
import type { ConverterLimits } from './limits.js';

/** Text of the leaf nodes in search text (R7.5): the image's alt text, a space for a hard break, nothing for raw HTML. */
function leafText(node: { type: { name: string }; attrs: Readonly<Record<string, unknown>> }): string {
  switch (node.type.name) {
    case 'image': {
      const alt = node.attrs['alt'];
      return typeof alt === 'string' ? alt : '';
    }
    case 'hardbreak':
      return ' ';
    default:
      return '';
  }
}

export { sanitise } from './guards.js';

/** Search text: no leading or trailing line break, no empty lines (a block without text, such as raw HTML, leaves one). */
const tidy = (text: string): string => text.replace(/\n{2,}/g, '\n').replace(/^\n|\n$/g, '');

/**
 * Yjs update bytes in, Markdown and search text out, or a typed failure. Never throws and never returns partial
 * Markdown as success. Pure: no state is kept between calls (the Milkdown context is a cache), so a worker may run it.
 * A failure carries a typed kind and a fixed sentence, never the text of an error or of the page.
 */
export async function convertInProcess(state: Uint8Array, limits?: Partial<ConverterLimits>): Promise<ConvertResult> {
  return convertWith(getHeadless, state, limits);
}

/** The conversion on a given headless context: for tests that try a schema change. */
export async function convertWith(
  headlessOf: () => Promise<Headless>,
  state: Uint8Array,
  limits?: Partial<ConverterLimits>,
): Promise<ConvertResult> {
  try {
    const resolved = resolveLimits(limits);
    const headless = await headlessOf();
    const guarded = guardState(state, resolved, headless.schema);
    if (!guarded.ok) return guarded;
    const doc = yXmlFragmentToProseMirrorRootNode(guarded.fragment, headless.schema);
    const lost = checkNoLoss(doc, guarded);
    if (lost !== undefined) return { ok: false, reason: 'content-lost', detail: lost };
    // Markdown and search text both come from the normal form: the document as Markdown can keep it, so the two agree.
    const written = normaliseForMarkdown(doc);
    const crowded = tooManyChildren(written, resolved.maxBlocks);
    if (crowded !== undefined) return { ok: false, reason: 'too-large', detail: crowded };
    const serialised = headless.serialize(written);
    // What is stored must be rebuildable by `reseed` (see the port's invariant), so it is held to the same pre-check, on the text that is stored: after
    // `sanitise` (a NUL becomes three bytes), and for every limit the rebuild has, not the size alone (a code line of 101 quote markers is written as is).
    const markdown = sanitise(serialised);
    const unrebuildable = seedMarkdownProblem(markdown, { maxSeedMarkdownBytes: resolved.maxReseedMarkdownBytes, maxSeedLines: Number.MAX_SAFE_INTEGER, maxSeedLineMarkers: resolved.maxReseedLineMarkers });
    if (unrebuildable !== undefined) return { ok: false, reason: 'too-large', detail: unrebuildable.message };
    // The verifying parse is bounded by the caller's time limit, not by a pre-check; nesting is bounded by the depth guard above.
    if (resolved.verifyRoundTrip) {
      const difference = compareDocuments(written.toJSON(), headless.parse(serialised).toJSON());
      // The place is a path of node types, never page text.
      if (difference !== undefined) return { ok: false, reason: 'content-lost', detail: `the Markdown does not read back as the same document (${difference})`.slice(0, 200) };
    }
    const text = written.textBetween(0, written.content.size, '\n', leafText);
    return { ok: true, markdown, text: tidy(sanitise(text)) };
  } catch (error: unknown) {
    // A stack overflow means nesting the depth check did not foresee; anything else is a bug, never a partial result.
    if (error instanceof RangeError) return { ok: false, reason: 'too-deep', detail: 'stack overflow while converting' };
    return { ok: false, reason: 'internal', detail: 'unexpected error while converting' };
  }
}
