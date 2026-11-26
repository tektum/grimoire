// constructed: [F§6]: the rules of this file are built from the documented export format and other importers' tests, not observed on a real export (M7-T08 checks them).

import { markdownProfile } from '../markdown-profile.js';

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

/**
 * constructed: [F§6] the title of a page: its file name without the id; else, for a name that is only an id, the title a plain Markdown zip gives (R10.17: the first heading
 * outside code and front matter, else the file name), so the two profiles read a heading the same way.
 */
export function titleOf(path: string, markdown: string): string {
  const { base } = splitName(path.split('/').at(-1) ?? path);
  return base !== '' ? base : markdownProfile.titleOf(path, markdown);
}

/** constructed: [F§6] the id of the last segment of a path; a database exported as `X <id>_all.csv` carries its id too (M7-T08: a real export names its databases so). */
export const idOf = (path: string): string | undefined => splitName((path.split('/').at(-1) ?? '').replace(/_all(\.\w+)$/i, '$1')).id;
