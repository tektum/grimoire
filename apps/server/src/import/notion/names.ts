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

/** constructed: [F§6] the title of a page: its file name without the id; else the first heading of its Markdown (R10.5); else the file name as it is. */
export function titleOf(path: string, markdown: string): string {
  const file = path.split('/').at(-1) ?? path;
  const { base, ext } = splitName(file);
  if (base !== '') return base;
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1];
  return heading ?? file.slice(0, file.length - ext.length);
}

/**
 * constructed: [F§6] the page a page is a child of: a page `X <id>.md` with a sibling folder `X <id>/` has that folder's pages as children, so the parent of a file is the page file named
 * like its folder (`X <id>.md` next to `X <id>/`). A folder with no id has no page file of its own: the parent is the folder itself (`X/`). A file at the top has no parent.
 */
export function parentPathOf(path: string): string | null {
  const segments = path.split('/');
  if (segments.length < 2) return null;
  const folder = segments.at(-2) as string;
  const above = segments.slice(0, -2);
  return splitName(folder).id === undefined ? `${segments.slice(0, -1).join('/')}/` : [...above, `${folder}.md`].join('/');
}
