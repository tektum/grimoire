import { markdownProfile } from '../markdown-profile.js';
import type { ImportProfile } from '../profile.js';
import { resolveNotionLink } from './links.js';
import { splitName, titleOf } from './names.js';

/** A path without `.` and empty segments, as the engine and `resolveLinkPath` read it. */
const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment !== '' && segment !== '.');

/** The folders of an archive (lower-cased, as `lowerPaths` holds its files), once for each set of paths. */
const folderSets = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();
function foldersOf(lowerPaths: ReadonlySet<string>): ReadonlySet<string> {
  let folders = folderSets.get(lowerPaths);
  if (folders === undefined) {
    const made = new Set<string>();
    for (const p of lowerPaths) { const s = p.split('/'); for (let i = 1; i < s.length; i++) made.add(s.slice(0, i).join('/')); }
    folders = made;
    folderSets.set(lowerPaths, folders);
  }
  return folders;
}

/** How many page files of a folder are named `X` once their id is taken off, by `<folder>/x` (lower-cased), once for each set of paths. */
const nameCounts = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, number>>();
function pagesNamed(lowerPaths: ReadonlySet<string>): ReadonlyMap<string, number> {
  let counts = nameCounts.get(lowerPaths);
  if (counts === undefined) {
    const made = new Map<string, number>();
    for (const p of lowerPaths) {
      if (!/\.(md|markdown)$/.test(p)) continue;
      const s = p.split('/');
      const { base, id } = splitName((s.pop() ?? '').replace(/\.(md|markdown)$/, ''));
      if (id === undefined || base === '') continue;
      const key = [...s, base].join('/');
      made.set(key, (made.get(key) ?? 0) + 1);
    }
    counts = made;
    nameCounts.set(lowerPaths, counts);
  }
  return counts;
}

/**
 * The `notion_md_csv` profile (M7 contracts section 4, Notion rules; M7-T06): an export of Notion, read with the rules of `notion/`. Every rule is marked `constructed: [F§6]` until
 * M7-T08 confirms it against a real export.
 */
export const notionProfile: ImportProfile = {
  source: 'notion_md_csv',
  classify: markdownProfile.classify,
  titleOf,
  /** A page goes under the folder it sits in; which page stands for that folder is `folderPathOf`'s answer. */
  parentPathOf(path) {
    const folder = segmentsOf(path).slice(0, -1);
    return folder.length === 0 ? null : folder.join('/');
  },
  /**
   * The folder a page stands for, so that the pages in it are its children: `X <id>/` beside `X <id>.md` (constructed: [F§6]), or `X/`, the name without the id, as a real export
   * names it (M7-T08). `X.md` owns `X/` as in any zip, so a page `X <id>.md` beside it does not. A folder `X/` beside two pages `X <id>.md` belongs to neither (which page it is
   * cannot be read from the names): it stays an empty page of its own. The name is split lower-cased, as `pagesNamed` counts it: folders are matched without case, the id too.
   */
  folderPathOf(path, lowerPaths) {
    const segments = segmentsOf(path);
    const stem = (segments.pop() ?? '').replace(/\.(md|markdown)$/i, '');
    const dir = segments.join('/');
    const at = (name: string): string => (dir === '' ? name : `${dir}/${name}`);
    const { base, id } = splitName(stem.normalize('NFC').toLowerCase());
    if (id === undefined || base === '' || lowerPaths === undefined) return at(stem);
    const folders = foldersOf(lowerPaths);
    if (folders.has(at(stem).normalize('NFC').toLowerCase())) return at(stem);
    const bare = at(base).normalize('NFC').toLowerCase();
    const plain = lowerPaths.has(`${bare}.md`) || lowerPaths.has(`${bare}.markdown`);
    if (!folders.has(bare) || plain || (pagesNamed(lowerPaths).get(bare) ?? 0) > 1) return at(stem);
    return at(base);
  },
  preprocess: markdownProfile.preprocess,
  resolveLink: resolveNotionLink,
};
