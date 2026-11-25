// constructed: [F§6]: the rules of this file are built from the documented export format and other importers' tests, not observed on a real export (M7-T08 checks them).

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

/** constructed: [F§6] the title of a page: its file name without the id; else the first heading of its Markdown (R10.5); else the file name as it is. */
export function titleOf(path: string, markdown: string): string {
  const file = path.split('/').at(-1) ?? path;
  const { base, ext } = splitName(file);
  if (base !== '') return base;
  // Linear: the line is captured whole and trimmed afterwards (a lazy group followed by a character class backtracks quadratically on a crafted line).
  const line = /^#{1,6}[ \t]+(.*)$/m.exec(markdown)?.[1];
  const heading = line === undefined ? '' : withoutClosingHashes(line.trim());
  return heading !== '' ? heading : file.slice(0, file.length - ext.length);
}
