import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import type { SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { guardState, markdownComplexityProblem, tooManyChildren } from './guards.js';
import { getHeadless } from './headless.js';
import { resolveLimits } from './limits.js';
import type { ConverterLimits } from './limits.js';

/** Fixed so the same Markdown always gives the same bytes; two seeds of one page then merge as one (Yjs ignores repeats). */
const SEED_CLIENT_ID = 3_000_000_000;

/** Markdown in, Yjs update bytes out, with no editor: Milkdown's parser, then y-prosemirror. Never throws. */
export async function seedInProcess(markdown: string, limits?: Partial<ConverterLimits>): Promise<SeedResult> {
  try {
    const resolved = resolveLimits(limits);
    if (typeof markdown !== 'string') return { ok: false, reason: 'invalid-markdown', detail: 'input is not a string' };
    if (Buffer.byteLength(markdown, 'utf8') > resolved.maxSeedMarkdownBytes) {
      return { ok: false, reason: 'too-large', detail: 'Markdown exceeds the seed limit' };
    }
    // Before the parser: it is quadratic in the delimiters of one paragraph (see `markdownComplexityProblem`).
    if (markdownComplexityProblem(markdown) !== undefined) return { ok: false, reason: 'too-large', detail: 'the Markdown has too many delimiters in one paragraph' };
    const headless = await getHeadless();
    let node;
    try {
      node = headless.parse(markdown);
    } catch {
      // Includes the stack overflow that deeply nested Markdown causes in the parser.
      return { ok: false, reason: 'invalid-markdown', detail: 'the Markdown could not be parsed' };
    }
    const doc = new Y.Doc();
    doc.clientID = SEED_CLIENT_ID;
    prosemirrorToYXmlFragment(node, doc.getXmlFragment(FRAGMENT_NAME));
    const state = Y.encodeStateAsUpdate(doc);
    if (state.byteLength > resolved.maxStateBytes) {
      return { ok: false, reason: 'too-large', detail: 'seeded state exceeds the state limit' };
    }
    // The converter's own guards on the seed's output (review finding F8): a page that no save could convert is not created.
    const guarded = guardState(state, resolved, headless.schema);
    if (!guarded.ok) {
      return guarded.reason === 'too-deep' || guarded.reason === 'too-large'
        ? { ok: false, reason: 'too-large', detail: `seeded document: ${guarded.detail}` }
        : { ok: false, reason: 'internal', detail: 'the seeded state failed the converter guards' };
    }
    const crowded = tooManyChildren(normaliseForMarkdown(node), resolved.maxBlocks);
    if (crowded !== undefined) return { ok: false, reason: 'too-large', detail: `seeded document: ${crowded}` };
    return { ok: true, state };
  } catch {
    return { ok: false, reason: 'internal', detail: 'unexpected error while seeding' };
  }
}
