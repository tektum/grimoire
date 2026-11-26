// constructed: [F§6]: the rules of this file are built from the documented export format and other importers' tests, not observed on a real export (M7-T08 checks them).

import { markdownProfile } from '../markdown-profile.js';
import { MAX_TITLE } from '../profile.js';

/** constructed: [F§6] the id suffix of a file or folder name: 32 lower-case hexadecimal characters after a space, after a dash or glued, then an optional extension. */
const ID_SUFFIX = /^(.*?)[ -]?([a-f0-9]{32})(\.\w+)?$/;

export interface SplitName { readonly base: string; readonly id: string | undefined; readonly ext: string }

/** A file or folder name split into its title part, the 32-character id (the last one when there are two), and the extension. */
export function splitName(name: string): SplitName {
  const m = ID_SUFFIX.exec(name);
  if (m !== null) return { base: (m[1] ?? '').trimEnd(), id: m[2] as string, ext: m[3] ?? '' };
  const ext = /\.\w+$/.exec(name)?.[0] ?? '';
  return { base: name.slice(0, name.length - ext.length), id: undefined, ext };
}

/** `Plan ##` is `Plan`; `C#` stays `C#` (the closing hashes must follow a space or tab). Linear: no regular expression. */
function withoutClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length || end === 0 || (text[end - 1] !== ' ' && text[end - 1] !== '\t')) return text;
  return text.slice(0, end).trimEnd();
}

/** The `# heading` on the first line: its text, closing hashes off, and the length of the line with its line break; undefined when there is none or its text is empty. */
function titleLine(markdown: string): { readonly text: string; readonly length: number } | undefined {
  // Linear: anchored at the start, and nothing after the greedy runs can fail, so nothing backtracks.
  const m = /^#[ \t]+([^\r\n\u2028\u2029]*)(\r\n|[\r\n\u2028\u2029])?/.exec(markdown);
  const text = m === null ? '' : withoutClosingHashes((m[1] ?? '').trim());
  return m === null || text === '' ? undefined : { text, length: m[0].length };
}

/**
 * The title of a page: the `# heading` on its first line (decision 169: a real export writes the whole title there, while its file name may be cut at 50 characters or have
 * characters replaced); else its file name without the id; else, for a name that is only an id, the title a plain Markdown zip gives (R10.17: the first heading outside code and
 * front matter, else the file name), so the two profiles read a heading the same way.
 */
export function titleOf(path: string, markdown: string): string {
  const line = titleLine(markdown);
  if (line !== undefined) return line.text;
  // A database's `X <id>_all.csv` is titled `X`, as its `X <id>.csv` would be (M7-T08).
  const { base } = splitName((path.split('/').at(-1) ?? path).replace(/_all(\.csv)$/i, '$1'));
  return base !== '' ? base : markdownProfile.titleOf(path, markdown);
}

/**
 * The Markdown of a page without its first line when that line is the `# heading` that is its title (decision 170: a real export repeats the title there, so the page would
 * show it twice). Nothing else is left out, and a heading longer than a title stays: the title is cut, the line keeps all of it.
 */
export function withoutTitleLine(markdown: string): string {
  const line = titleLine(markdown);
  return line === undefined || [...line.text].length > MAX_TITLE ? markdown : markdown.slice(line.length);
}

/** constructed: [F§6] the id of the last segment of a path; a database exported as `X <id>_all.csv` carries its id too (M7-T08: a real export names its databases so). */
export const idOf = (path: string): string | undefined => splitName((path.split('/').at(-1) ?? '').replace(/_all(\.\w+)$/i, '$1')).id;
