import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { convertInProcess } from '../convert.js';
import { getHeadless } from '../headless.js';
import { generateEditorDocument, generateRandomDocument } from './generate.js';
import { stateFromDocJson, stateFromMarkdownDirect } from './states.js';

/** Seeded sweeps shared by the unit tests (small) and the benchmark project (full size). They return problems, not asserts. */

/** Same document, ignoring the list `spread` flag and key order. */
const strict = (node: unknown): string =>
  JSON.stringify(node, (key, value: unknown) => {
    if (key === 'spread') return undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value;
  });

/** Documents read from Markdown (seeds `i*7919`): every one must convert. Returns the refusals. */
export async function markdownSweep(count: number): Promise<string[]> {
  const refused: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const result = await convertInProcess(await stateFromMarkdownDirect(generateRandomDocument(i * 7919)));
    if (!result.ok) refused.push(`${i}: ${result.detail}`);
  }
  return refused;
}

/**
 * Editor-made documents: each is converted; a refusal must be `content-lost`; an accepted one differs from its read-back
 * only by the named rules, so the read-back, converted again, must be an exact fixed point with no rule needed.
 */

interface SweepNode { type?: string; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: SweepNode[] }
/** The email form CommonMark allows between `<` and `>`: a domain label has no underscore, so `me@x.coma_b` is not an autolink. */
const VALID_AUTOLINK_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** Is there a run read back as a `mailto:` link whose text cannot be written as an autolink (the one known cause of that refusal)? */
function hasInvalidAutolinkAddress(node: SweepNode): boolean {
  const link = node.marks?.find((mark) => mark.type === 'link');
  if (node.type === 'text' && link && link.attrs?.['href'] === `mailto:${node.text ?? ''}` && !VALID_AUTOLINK_EMAIL.test(node.text ?? '')) return true;
  return (node.content ?? []).some(hasInvalidAutolinkAddress);
}

export async function editorSweep(count: number): Promise<{ problems: string[]; counts: { ok: number; refused: number; addressReadBack: number } }> {
  const headless = await getHeadless();
  const counts = { ok: 0, refused: 0, addressReadBack: 0 };
  const problems: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const first = await convertInProcess(await stateFromDocJson(generateEditorDocument(i)));
    if (!first.ok) {
      counts.refused += 1;
      if (first.reason !== 'content-lost') problems.push(`${i}: refused as ${first.reason}`);
      continue;
    }
    counts.ok += 1;
    const back = headless.parse(first.markdown);
    const second = await convertInProcess(await stateFromDocJson(back.toJSON()));
    if (!second.ok) {
      // Known and pinned: a read-back whose address-link has an address that is not a valid autolink (`me@x.coma_b`) is
      // written `<me@x.coma_b>`, which a reader does not take for a link: refused on the second conversion, state kept.
      if (!hasInvalidAutolinkAddress(back.toJSON() as SweepNode)) problems.push(`${i}: read-back refused: ${second.reason}: ${second.detail}`);
      else counts.addressReadBack += 1;
      continue;
    }
    const normal = normaliseForMarkdown(back);
    if (strict(normal.toJSON()) !== strict(headless.parse(headless.serialize(normal)).toJSON())) problems.push(`${i}: read-back is not an exact fixed point`);
  }
  return { problems, counts };
}
