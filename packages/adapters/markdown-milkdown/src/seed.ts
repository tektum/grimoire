import { randomInt } from 'node:crypto';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import type { SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { guardState, seedMarkdownProblem, tooManyChildren } from './guards.js';
import { getHeadless } from './headless.js';
import { resolveLimits } from './limits.js';
import type { ConverterLimits } from './limits.js';

/**
 * The identity of the system rebuild (`reseedInProcess`), fixed so the same stored Markdown always gives the same bytes: the collaboration host
 * then re-identifies it from the page, so servers that rebuild one row at once agree.
 */
const SEED_CLIENT_ID = 3_000_000_000;

/** A fresh identity for one seed of user Markdown: a state that is stored as it is must never share an identity (and so a clock) with any other seed. */
function freshClientId(): number {
  let id = SEED_CLIENT_ID;
  while (id === SEED_CLIENT_ID) id = randomInt(1, 2 ** 32);
  return id;
}

/** The pre-check limits of one entry point. */
type Precheck = Pick<ConverterLimits, 'maxSeedMarkdownBytes' | 'maxSeedLines' | 'maxSeedLineMarkers'>;

/**
 * Markdown that a person or another system supplied, in, Yjs update bytes out, with no editor: Milkdown's parser, then y-prosemirror.
 * The size, line and marker limits are the user's (`maxSeed*`). Never throws.
 */
export function seedInProcess(markdown: string, limits?: Partial<ConverterLimits>): Promise<SeedResult> {
  return build(markdown, limits, (resolved) => resolved, freshClientId);
}

/**
 * Markdown that OUR OWN serialiser stored, in; the system rebuilds the page's editor state from it. Its own limits (`maxReseed*`: up
 * to the stored-Markdown cap, no line cap, a higher marker cap that the serialiser itself can reach); the pool gives it a longer time
 * limit. A separate function, so that user-supplied Markdown can never be handed the lenient limits: `seedInProcess` does not read them.
 */
export function reseedInProcess(markdown: string, limits?: Partial<ConverterLimits>): Promise<SeedResult> {
  return build(markdown, limits, (resolved) => ({
    maxSeedMarkdownBytes: resolved.maxReseedMarkdownBytes,
    maxSeedLines: Number.MAX_SAFE_INTEGER,
    maxSeedLineMarkers: resolved.maxReseedLineMarkers,
  }), () => SEED_CLIENT_ID);
}

async function build(markdown: string, limits: Partial<ConverterLimits> | undefined, precheck: (resolved: ConverterLimits) => Precheck, clientId: () => number): Promise<SeedResult> {
  try {
    const resolved = resolveLimits(limits);
    if (typeof markdown !== 'string') return { ok: false, reason: 'invalid-markdown', detail: 'input is not a string' };
    // Before the parser: size, lines and nesting markers only. The parser's time is bounded by the worker's time limit, not here.
    const problem = seedMarkdownProblem(markdown, precheck(resolved));
    if (problem !== undefined) return { ok: false, reason: 'too-large', detail: problem.message };
    const headless = await getHeadless();
    let node;
    try {
      node = headless.parse(markdown);
    } catch {
      // Includes the stack overflow that deeply nested Markdown causes in the parser.
      return { ok: false, reason: 'invalid-markdown', detail: 'the Markdown could not be parsed' };
    }
    const doc = new Y.Doc();
    doc.clientID = clientId();
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
